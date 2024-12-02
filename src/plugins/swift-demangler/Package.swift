// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "swift-demangler",
    targets: [
        .executableTarget(name: "swift-demangler", swiftSettings: [
            .enableExperimentalFeature("Extern")
        ], linkerSettings: [
            .linkedLibrary("swiftCore"),
        ]),
    ]
)
