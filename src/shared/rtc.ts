/**
 * The browser tab as live video over WebRTC, for a device of the remote link
 * that plays it (main/remote/rtc.ts, renderer/src/rtc, renderer/src/remote/
 * rtc-player.ts). Chromium captures the tab from its compositor and keeps it
 * drawing while captured; WebRTC encodes it, paces it to the connection and
 * carries it over UDP, through a TURN relay when the networks need one. The
 * remote link's socket carries only the offer, the answer and candidates.
 */

/** Where WebRTC may connect through: STUN, and TURN with credentials. */
export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

/** From the Mac to the device, as remoteBrowser:rtc. */
export type RtcSignal =
  | { type: 'offer'; sdp: string; iceServers: IceServer[] }
  | { type: 'candidate'; candidate: RtcCandidate }
  /** The video stopped for good: the device shows pictures again. */
  | { type: 'off' }

/** An ICE candidate as it goes over the socket (RTCIceCandidateInit). */
export interface RtcCandidate {
  candidate: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
}

/** From the main process to the streaming page. */
export type RtcCommand =
  | {
      t: 'open'
      id: number
      sourceId: string
      /** The largest picture, in pixels. */
      width: number
      height: number
      /** The device's pixels per CSS pixel, which that picture is at. */
      ratio: number
      iceServers: IceServer[]
    }
  | { t: 'answer'; id: number; sdp: string }
  | { t: 'candidate'; id: number; candidate: RtcCandidate }
  | { t: 'close'; id: number }

/** From the streaming page to the main process. */
export type RtcEvent =
  | { t: 'ready' }
  | { t: 'offer'; id: number; sdp: string }
  | { t: 'candidate'; id: number; candidate: RtcCandidate }
  /** The connection failed or the capture could not start. */
  | { t: 'failed'; id: number; message: string }
