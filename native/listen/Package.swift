// swift-tools-version: 6.1
import PackageDescription

// The meeting's ears (src/main/meeting.ts): Moonshine's streaming speech-to-text,
// run on this Mac. Built by `npm run build:listen` and shipped in the app's Resources.
let package = Package(
    name: "BareboneListen",
    // Moonshine's prebuilt library targets 13.4.
    platforms: [.macOS("13.4")],
    dependencies: [
        .package(url: "https://github.com/moonshine-ai/moonshine-swift.git", exact: "0.1.5")
    ],
    targets: [
        .executableTarget(
            name: "barebone-listen",
            dependencies: [.product(name: "MoonshineVoice", package: "moonshine-swift")]
        )
    ]
)
