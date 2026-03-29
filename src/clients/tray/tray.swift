// awacs-tray — macOS menu bar client for AWACS
// Run: swift tray.swift

import Cocoa

let AWACS_URL = "http://localhost:7777"

class TrayDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        // Draw a green radar dot matching the Windows icon
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { rect in
            NSColor(red: 0.12, green: 0.12, blue: 0.12, alpha: 1).setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 1, dy: 1)).fill()
            NSColor(red: 0.2, green: 0.85, blue: 0.3, alpha: 1).setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 4, dy: 4)).fill()
            return true
        }
        image.isTemplate = false
        statusItem.button?.image = image
        statusItem.button?.toolTip = "AWACS"

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "o"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
        statusItem.menu = menu
    }

    @objc func openDashboard() {
        NSWorkspace.shared.open(URL(string: AWACS_URL)!)
    }

    @objc func quit() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = TrayDelegate()
app.delegate = delegate
app.run()
