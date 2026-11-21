import type { RtcCandidate, RtcSignal } from '../../../shared/rtc'

/**
 * The browser tab as live WebRTC video on a device (shared/rtc.ts): the Mac
 * offers, this answers, and the video plays in a <video>, decoded in hardware
 * and paced by WebRTC to the connection. If it cannot connect or shows
 * nothing in time, it says so, and the Mac sends pictures instead.
 */

/** Whether this browser plays the video. */
export function playsRtc(): boolean {
  return typeof RTCPeerConnection === 'function'
}

/** How long the video may take to show its first picture before pictures are sent instead. */
const FIRST_PICTURE_MS = 15_000

export interface RtcPlayerHost {
  video(): HTMLVideoElement | null
  answer(sdp: string): Promise<void>
  candidate(candidate: RtcCandidate): void
  /** It cannot play: the Mac sends pictures instead. */
  failed(): void
}

export class RtcPlayer {
  private pc?: RTCPeerConnection
  private watchdog?: ReturnType<typeof setTimeout>

  constructor(private readonly host: RtcPlayerHost) {}

  async signal(signal: RtcSignal): Promise<void> {
    if (signal.type === 'off') return this.close()
    if (signal.type === 'candidate') {
      await this.pc?.addIceCandidate(signal.candidate).catch(() => undefined)
      return
    }
    this.close()
    const pc = new RTCPeerConnection({ iceServers: signal.iceServers })
    this.pc = pc
    pc.ontrack = ({ track, receiver }) => {
      // As little buffering as the browser allows: each picture shows as it comes.
      if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0
      const video = this.host.video()
      if (!video) return
      video.srcObject = new MediaStream([track])
      video.play().catch(() => undefined)
    }
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || this.pc !== pc) return
      const { candidate: line, sdpMid, sdpMLineIndex } = candidate
      this.host.candidate({ candidate: line, sdpMid, sdpMLineIndex })
    }
    pc.onconnectionstatechange = () => {
      if (this.pc === pc && pc.connectionState === 'failed') this.fail()
    }
    this.watchdog = setTimeout(() => this.fail(), FIRST_PICTURE_MS)
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp })
      await pc.setLocalDescription()
      const sdp = pc.localDescription?.sdp
      if (!sdp) throw new Error('No answer was made.')
      if (this.pc === pc) await this.host.answer(sdp)
    } catch {
      if (this.pc === pc) this.fail()
    }
  }

  /** The first picture showed: the video plays. */
  playing(): void {
    clearTimeout(this.watchdog)
  }

  close(): void {
    clearTimeout(this.watchdog)
    this.pc?.close()
    this.pc = undefined
    const video = this.host.video()
    if (video) video.srcObject = null
  }

  private fail(): void {
    if (!this.pc) return
    this.close()
    this.host.failed()
  }
}
