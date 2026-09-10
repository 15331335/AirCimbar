//
//  AirCimbarApp.swift
//  AirCimbar
//
//  Standalone screen-to-camera file transfer. Everything the app needs —
//  the UI, the cimbar encoder/decoder and the transfer engine — is bundled
//  inside the app. It never contacts the network: the web layer is served
//  from a loopback socket on the device itself, so the app behaves normally
//  in airplane mode.
//

import SwiftUI

@main
struct AirCimbarApp: App {

    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
        }
    }
}
