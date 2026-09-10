//
//  ContentView.swift
//  AirCimbar
//
//  The native shell. The interface itself lives in the bundled web app; this
//  layer exists to own the things a web view cannot: starting the local
//  server, the camera permission prompt, and telling the user when something
//  failed instead of showing a blank screen.
//

import SwiftUI

struct ContentView: View {

    @StateObject private var engine = WebEngine()
    @State private var cameraStatus: CameraPermission.Status = CameraPermission.current
    @State private var showPermissionBanner = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            content
        }
        .task {
            engine.start()
            // Ask for the camera up front so a denial is a clear, actionable
            // state rather than a viewfinder that silently never starts.
            CameraPermission.request { status in
                cameraStatus = status
                showPermissionBanner = (status == .denied)
            }
        }
        .onDisappear { engine.stop() }
    }

    @ViewBuilder
    private var content: some View {
        switch engine.phase {
        case .starting:
            StatusScreen(
                symbol: "square.grid.3x3.fill",
                title: "正在启动",
                message: "准备内置的码流引擎…",
                tint: .gray
            )

        case .failed(let message):
            StatusScreen(
                symbol: "exclamationmark.triangle.fill",
                title: "无法启动",
                message: message,
                tint: .orange,
                actionTitle: "重试"
            ) {
                engine.stop()
                engine.start()
            }

        case .running:
            if let url = engine.startURL {
                ZStack(alignment: .top) {
                    WebContainer(engine: engine, url: url, reloadToken: engine.reloadToken)
                        .ignoresSafeArea(edges: .bottom)

                    if showPermissionBanner {
                        PermissionBanner {
                            CameraPermission.openSettings()
                        } onDismiss: {
                            showPermissionBanner = false
                        }
                    }
                }
            } else {
                StatusScreen(
                    symbol: "exclamationmark.triangle.fill",
                    title: "地址无效",
                    message: "本地服务没有给出可用的地址。",
                    tint: .orange
                )
            }
        }
    }
}

// MARK: - Pieces

private struct StatusScreen: View {
    let symbol: String
    let title: String
    let message: String
    let tint: Color
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 44))
                .foregroundStyle(tint)
            Text(title)
                .font(.title3.weight(.bold))
                .foregroundStyle(.white)
            Text(message)
                .font(.callout)
                .multilineTextAlignment(.center)
                .foregroundStyle(.white.opacity(0.7))
                .padding(.horizontal, 32)

            if let actionTitle, let action {
                Button(action: action) {
                    Text(actionTitle)
                        .font(.body.weight(.semibold))
                        .padding(.horizontal, 26)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent)
                .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Shown when camera access was refused — the receive tab is useless without
/// it, so say so plainly and offer the one useful action.
private struct PermissionBanner: View {
    let onOpenSettings: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "camera.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 3) {
                Text("摄像头权限未开启")
                    .font(.footnote.weight(.semibold))
                Text("接收文件需要摄像头。发送和导入解码不受影响。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            Button("去设置", action: onOpenSettings)
                .font(.caption.weight(.semibold))
            Button {
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
            }
            .buttonStyle(.plain)
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }
}
