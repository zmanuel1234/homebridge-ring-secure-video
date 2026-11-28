import type { RecordingPacket } from 'homebridge'

interface Mp4Box {
  type: string
  box: Buffer
}

function* parseMp4Boxes(data: Buffer): Generator<Mp4Box> {
  let offset = 0

  while (offset + 8 <= data.length) {
    const shortLength = data.readUInt32BE(offset)
    let boxLength = shortLength
    let headerLength = 8

    if (shortLength === 1) {
      if (offset + 16 > data.length) {
        break
      }

      boxLength = Number(data.readBigUInt64BE(offset + 8))
      headerLength = 16
    } else if (shortLength === 0) {
      break
    }

    if (boxLength < headerLength || offset + boxLength > data.length) {
      break
    }

    const box = data.subarray(offset, offset + boxLength),
      type = box.subarray(4, 8).toString('ascii')

    yield { type, box }

    offset += boxLength
  }
}

// The track ID of the video track in the init segment's moov (trak > tkhd, mdia > hdlr "vide").
function findVideoTrackId(moov: Buffer) {
  for (const { type, box: trak } of parseMp4Boxes(moov.subarray(8))) {
    if (type !== 'trak') {
      continue
    }

    let trackId: number | undefined
    let isVideo = false

    for (const { type: childType, box } of parseMp4Boxes(trak.subarray(8))) {
      if (childType === 'tkhd' && box.length >= (box[8] === 1 ? 32 : 24)) {
        // version 1 has 64-bit creation and modification times before track_ID
        trackId = box.readUInt32BE(box[8] === 1 ? 28 : 20)
      } else if (childType === 'mdia') {
        for (const { type: mediaType, box: hdlr } of parseMp4Boxes(box.subarray(8))) {
          if (mediaType === 'hdlr' && hdlr.length >= 20) {
            isVideo = hdlr.subarray(16, 20).toString('ascii') === 'vide'
          }
        }
      }
    }

    if (isVideo && trackId !== undefined) {
      return trackId
    }
  }

  return undefined
}

// Whether a fragment's first sample is a keyframe (sync sample). Reads the sample flags of the
// video track's run in moof > traf (or the first track when the video track is unknown): trun's
// first-sample flags, else its first per-sample flags, else tfhd's default flags. Bit 0x10000
// is "sample is not a sync sample". Unknown or unreadable: true.
function fragmentStartsWithKeyframe(boxes: Buffer[], videoTrackId?: number) {
  for (const moof of boxes) {
    if (moof.subarray(4, 8).toString('ascii') !== 'moof') {
      continue
    }

    for (const { type, box: traf } of parseMp4Boxes(moof.subarray(8))) {
      if (type !== 'traf') {
        continue
      }

      let defaultFlags: number | undefined

      for (const { type: childType, box } of parseMp4Boxes(traf.subarray(8))) {
        if (box.length < 16) {
          continue
        }

        const flags = box.readUInt32BE(8) & 0xffffff

        if (childType === 'tfhd') {
          if (videoTrackId !== undefined && box.readUInt32BE(12) !== videoTrackId) {
            break // another track (audio): its samples don't decide
          }

          let offset = 16 // header, version/flags, track_ID
          if (flags & 0x1) offset += 8 // base_data_offset
          if (flags & 0x2) offset += 4 // sample_description_index
          if (flags & 0x8) offset += 4 // default_sample_duration
          if (flags & 0x10) offset += 4 // default_sample_size
          if (flags & 0x20 && offset + 4 <= box.length) {
            defaultFlags = box.readUInt32BE(offset)
          }
        } else if (childType === 'trun') {
          let offset = 16 // header, version/flags, sample_count
          if (flags & 0x1) offset += 4 // data_offset
          let sampleFlags = defaultFlags

          if (flags & 0x4) {
            if (offset + 4 <= box.length) {
              sampleFlags = box.readUInt32BE(offset) // first_sample_flags
            }
          } else if (flags & 0x400) {
            // per-sample flags, after the first sample's duration and size
            const at = offset + (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0)
            if (at + 4 <= box.length) {
              sampleFlags = box.readUInt32BE(at)
            }
          }

          return sampleFlags === undefined || (sampleFlags & 0x10000) === 0
        }
      }
    }
  }

  return true
}

export class FragmentedMp4Parser {
  private pendingData: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private initBoxes: Buffer[] = []
  private initSent = false
  private fragmentBoxes: Buffer[] = []
  private keyframeSeen = false
  private videoTrackId?: number

  private readonly maxPendingBytes: number

  constructor(maxPendingBytes = 16 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1) {
      throw new Error('Fragmented MP4 maxPendingBytes must be a positive integer')
    }

    this.maxPendingBytes = maxPendingBytes
  }

  get hasInitializationSegment() {
    return this.initSent
  }

  append(data: Buffer) {
    const packets: RecordingPacket[] = []
    this.pendingData = this.pendingData.length
      ? Buffer.concat([this.pendingData, data])
      : data

    let consumed = 0

    for (const { type, box } of parseMp4Boxes(this.pendingData)) {
      consumed += box.length

      if (!this.initSent) {
        this.initBoxes.push(box)

        if (type === 'moov') {
          this.videoTrackId = findVideoTrackId(box)
          packets.push({
            data: Buffer.concat(this.initBoxes) as Buffer,
            isLast: false,
          })
          this.initBoxes = []
          this.initSent = true
        }

        continue
      }

      if (type === 'styp') {
        this.fragmentBoxes = [box]
        continue
      }

      if (type === 'moof') {
        this.fragmentBoxes = this.fragmentBoxes.length
          ? [...this.fragmentBoxes, box]
          : [box]
        continue
      }

      if (!this.fragmentBoxes.length) {
        continue
      }

      this.fragmentBoxes.push(box)

      // HomeKit discards a recording whose first fragment doesn't start with a keyframe.
      // Some encoders (the Raspberry Pi's V4L2 encoder) first emit their SPS/PPS as a sample
      // of its own, which FFmpeg puts in a fragment without a keyframe; drop fragments until
      // the first one that starts with a keyframe (with delay_moov the SPS/PPS are already
      // in the init segment, so nothing is lost).
      if (
        type === 'mdat' &&
        !this.keyframeSeen &&
        !fragmentStartsWithKeyframe(this.fragmentBoxes, this.videoTrackId)
      ) {
        this.fragmentBoxes = []
        continue
      }

      if (type === 'mdat') {
        this.keyframeSeen = true
        packets.push({
          data: Buffer.concat(this.fragmentBoxes) as Buffer,
          isLast: false,
        })
        this.fragmentBoxes = []
      }
    }

    if (consumed > 0) {
      this.pendingData = this.pendingData.subarray(consumed)
    }

    const retainedBytes =
      this.pendingData.length +
      this.initBoxes.reduce((total, box) => total + box.length, 0) +
      this.fragmentBoxes.reduce((total, box) => total + box.length, 0)

    if (retainedBytes > this.maxPendingBytes) {
      // Complete fragments are emitted before this check. Only data that is
      // still waiting for an MP4 boundary counts against the retained-data
      // cap, so valid large `mdat` boxes are not rejected mid-stream.
      throw new Error(
        `Fragmented MP4 retained data exceeded ${this.maxPendingBytes} bytes`,
      )
    }

    return packets
  }
}
