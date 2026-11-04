import Foundation
import MoonshineVoice

// Transcribes a meeting as it happens, for src/main/meeting.ts.
//
//   barebone-listen <model dir> <tiny-streaming|small-streaming> [key term]...
//
// Reads 16 kHz mono audio from stdin as 32-bit little-endian floats and writes
// one JSON object per line to stdout:
//   {"type":"ready"}
//   {"type":"started"}                      someone began a new line
//   {"type":"completed","text":"…","start":1.2,"duration":3.4}
//   {"type":"error","message":"…"}
// Ends when stdin closes, after the last line is out. The model files are the
// app's to download and check; this only loads them.

func emit(_ object: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

func fail(_ message: String) -> Never {
    emit(["type": "error", "message": message])
    exit(1)
}

final class Lines: TranscriptEventListener {
    func onLineStarted(_ event: LineStarted) {
        emit(["type": "started"])
    }

    func onLineCompleted(_ event: LineCompleted) {
        let line = event.line
        let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        emit([
            "type": "completed", "text": text,
            "start": Double(line.startTime), "duration": Double(line.duration),
        ])
    }

    func onError(_ event: TranscriptError) {
        emit(["type": "error", "message": "\(event)"])
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count >= 2 else {
    fail("usage: barebone-listen <model dir> <tiny-streaming|small-streaming> [key term]...")
}
let arches: [String: ModelArch] = ["tiny-streaming": .tinyStreaming, "small-streaming": .smallStreaming]
guard let arch = arches[arguments[1]] else { fail("unknown model size \(arguments[1])") }
let keyterms = arguments.dropFirst(2).filter { !$0.isEmpty && !$0.contains(",") }

let stream: MoonshineVoice.Stream
let lines = Lines()
do {
    let transcriber = try Transcriber(modelPath: arguments[0], modelArch: arch)
    if !keyterms.isEmpty { try transcriber.setKeyterms(Array(keyterms)) }
    // Partial text every 0.3 s: lines complete sooner after speech stops.
    stream = try transcriber.createStream(updateInterval: 0.3)
    stream.addListener(lines)
    try stream.start()
} catch {
    fail("Could not load the speech model: \(error)")
}
emit(["type": "ready"])

// 20 ms of audio per read at most; a read returns what has arrived.
let input = FileHandle.standardInput
var pending = Data()
while let chunk = try? input.read(upToCount: 1280), !chunk.isEmpty {
    pending.append(chunk)
    let whole = pending.count / 4 * 4
    if whole == 0 { continue }
    // Copied, not bound in place: Data's bytes need not be aligned for Float.
    var samples = [Float](repeating: 0, count: whole / 4)
    let end = pending.startIndex + whole
    _ = samples.withUnsafeMutableBytes { pending.copyBytes(to: $0, from: pending.startIndex..<end) }
    pending = pending.subdata(in: end..<pending.endIndex)
    do {
        try stream.addAudio(samples, sampleRate: 16000)
    } catch {
        fail("Could not transcribe: \(error)")
    }
}
try? stream.stop()
stream.close()
