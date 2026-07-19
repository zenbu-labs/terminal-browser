import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let scale = NSScreen.main?.backingScaleFactor ?? 2.0
print("scale \(scale)")
fflush(stdout)

NSEvent.addGlobalMonitorForEvents(matching: .scrollWheel) { event in
    let precise = event.hasPreciseScrollingDeltas ? 1 : 0
    print("s \(event.scrollingDeltaY) \(event.phase.rawValue) \(event.momentumPhase.rawValue) \(precise) \(event.scrollingDeltaX)")
    fflush(stdout)
}

// Pinch cannot ride an NSEvent monitor: macOS never delivers gesture events
// for other apps to global monitors. Instead we read raw finger contacts from
// the trackpad through the MultitouchSupport system framework (private, loaded
// at runtime, no permission prompt) and recognize the pinch ourselves.
//
// The scroll-vs-pinch classification follows libinput and the ChromeOS
// gesture library: each finger's displacement since touch start must clear an
// absolute floor, and the decision comes from the angle between the two
// displacement vectors — fingers moving the same way are a scroll, fingers
// moving against each other are a pinch. Close-together fingers default to
// scroll after a timeout. A scroll may upgrade to a pinch only briefly after
// touch start; after that both readings are locked until the fingers lift, so
// a pan can never leak zoom events mid-gesture.
//
// A recognized pinch reports the fractional change of finger distance
// (distance / lastEmitted - 1, matching NSEvent.magnification), rate-limited
// by a distance hysteresis so resting fingers do not jitter the zoom.
//
// Each contact in the callback buffer is a fixed-size 96-byte record; the
// fields we need, by byte offset (positions are normalized to the trackpad
// surface, 0..1; a millimeter is roughly 0.01 of a trackpad width):
//   16: identifier    20: touch phase    32/36: position x/y    48: size
private let fingerStride = 96

// Thresholds in trackpad-normalized units (values from libinput, in mm,
// converted at ~0.01 per mm) and unitless angle/ratio gates from ChromeOS.
private let noiseFloorMove: Float = 0.010    // 1mm: below this nothing classifies
private let classifyMove: Float = 0.015      // 1.5mm: per-finger floor for the angle test
private let soloMove: Float = 0.040          // 4mm: one finger moving alone means scroll
private let certainMove: Float = 0.080       // 8mm: both fingers opposing locks pinch at once
private let scrollSeparationX: Float = 0.40  // 40mm: fingers this close default to...
private let scrollSeparationY: Float = 0.09  // 7mm:  ...scroll after the timeout
private let scrollDefaultAfter = 0.150       // seconds before close fingers mean scroll
private let reclassifyWindow = 0.300         // seconds a scroll may still become a pinch
private let pinchMaxCosine: Float = -0.4     // displacement vectors 113°+ apart
private let pinchMovementRatio: Float = 0.4  // slower finger must do 40% of faster one
private let jitterRatio: Float = 1.005       // min distance² change to emit
private let restingJitterRatio: Float = 1.05 // after 100ms idle or direction reversal
private let restingAfter = 0.100

private struct Contact {
    var id: Int32
    var x: Float
    var y: Float
}

private struct TouchTrack {
    enum Mode { case undecided, pinch, scroll }
    var mode: Mode
    var ids: (Int32, Int32)
    var startTime: Double
    var initial: (Contact, Contact)
    var emittedDistance: Float
    var lastEmitTime: Double
    var lastDirection: Float
}

// Callbacks arrive on a thread per trackpad, so tracking is per device and
// guarded by a lock.
private final class PinchState {
    let lock = NSLock()
    var track: [Int32: TouchTrack] = [:]
}
private let pinchState = PinchState()

private typealias MTContactCallback =
    @convention(c) (Int32, UnsafeMutableRawPointer?, Int32, Double, Int32) -> Int32

private let contactCallback: MTContactCallback = { device, data, fingerCount, timestamp, _ in
    guard let data else { return 0 }
    var contacts: [Contact] = []
    for i in 0..<Int(fingerCount) {
        let base = data.advanced(by: i * fingerStride)
        let phase = base.load(fromByteOffset: 20, as: Int32.self)
        let size = base.load(fromByteOffset: 48, as: Float.self)
        // Only firmly-touching contacts (phases: 3 = landing, 4 = touching)
        // count; lifting fingers roll and would read as motion.
        guard phase == 3 || phase == 4, size > 0.05 else { continue }
        contacts.append(Contact(
            id: base.load(fromByteOffset: 16, as: Int32.self),
            x: base.load(fromByteOffset: 32, as: Float.self),
            y: base.load(fromByteOffset: 36, as: Float.self)
        ))
    }
    pinchState.lock.lock()
    defer { pinchState.lock.unlock() }
    guard contacts.count == 2 else {
        pinchState.track[device] = nil
        return 0
    }
    contacts.sort { $0.id < $1.id }
    let (a, b) = (contacts[0], contacts[1])
    let distance = hypotf(a.x - b.x, a.y - b.y)
    guard var track = pinchState.track[device],
          track.ids == (a.id, b.id), distance > 0 else {
        pinchState.track[device] = TouchTrack(
            mode: .undecided, ids: (a.id, b.id), startTime: timestamp,
            initial: (a, b), emittedDistance: distance,
            lastEmitTime: timestamp, lastDirection: 0)
        return 0
    }
    defer { pinchState.track[device] = track }

    let canUpgrade = track.mode == .scroll
        && timestamp - track.startTime < reclassifyWindow
    if track.mode == .undecided || canUpgrade {
        classify(&track, a: a, b: b, timestamp: timestamp, distance: distance)
    }
    if track.mode == .pinch {
        emitPinch(&track, distance: distance, timestamp: timestamp)
    }
    return 0
}

private func classify(
    _ track: inout TouchTrack, a: Contact, b: Contact,
    timestamp: Double, distance: Float
) {
    let d0 = (x: a.x - track.initial.0.x, y: a.y - track.initial.0.y)
    let d1 = (x: b.x - track.initial.1.x, y: b.y - track.initial.1.y)
    let m0 = hypotf(d0.x, d0.y)
    let m1 = hypotf(d1.x, d1.y)
    if m0 < noiseFloorMove && m1 < noiseFloorMove { return }
    let dot = d0.x * d1.x + d0.y * d1.y
    var decision: TouchTrack.Mode = track.mode
    if m0 >= certainMove, m1 >= certainMove, dot < 0 {
        decision = .pinch
    } else if m0 >= classifyMove, m1 >= classifyMove {
        let cosine = dot / max(m0 * m1, 0.0001)
        if cosine > pinchMaxCosine {
            decision = .scroll
        } else if min(m0, m1) / max(m0, m1) >= pinchMovementRatio {
            decision = .pinch
        }
    } else if track.mode == .undecided {
        if max(m0, m1) >= soloMove, min(m0, m1) < classifyMove {
            decision = .scroll
        } else if timestamp - track.startTime > scrollDefaultAfter,
                  abs(a.x - b.x) < scrollSeparationX,
                  abs(a.y - b.y) < scrollSeparationY {
            decision = .scroll
        }
    }
    track.mode = decision
    if decision == .pinch {
        // Motion spent deciding is dropped, so recognition does not open
        // with one jumpy zoom step.
        track.emittedDistance = distance
        track.lastEmitTime = timestamp
        track.lastDirection = 0
    }
}

private func emitPinch(_ track: inout TouchTrack, distance: Float, timestamp: Double) {
    guard track.emittedDistance > 0 else {
        track.emittedDistance = distance
        return
    }
    let distanceSq = distance * distance
    let emittedSq = track.emittedDistance * track.emittedDistance
    let direction: Float = distanceSq > emittedSq ? 1 : -1
    var threshold = jitterRatio
    if timestamp - track.lastEmitTime > restingAfter { threshold = restingJitterRatio }
    if track.lastDirection != 0, direction != track.lastDirection {
        threshold = max(threshold, restingJitterRatio)
    }
    guard distanceSq > emittedSq * threshold || distanceSq * threshold < emittedSq else {
        return
    }
    print("z \(distance / track.emittedDistance - 1)")
    fflush(stdout)
    track.emittedDistance = distance
    track.lastEmitTime = timestamp
    track.lastDirection = direction
}

private final class MultitouchPinch {
    private typealias CreateListFn = @convention(c) () -> Unmanaged<CFArray>?
    private typealias RegisterFn =
        @convention(c) (UnsafeMutableRawPointer, MTContactCallback) -> Void
    private typealias DeviceFn = @convention(c) (UnsafeMutableRawPointer, Int32) -> Void

    private var deviceList: CFArray?   // owns the device refs in `devices`
    private var devices: [UnsafeMutableRawPointer] = []
    private var createListFn: CreateListFn?
    private var registerFn: RegisterFn?
    private var startFn: DeviceFn?
    private var stopFn: DeviceFn?

    func start() {
        if createListFn == nil {
            let path = "/System/Library/PrivateFrameworks/MultitouchSupport.framework/MultitouchSupport"
            guard let lib = dlopen(path, RTLD_NOW),
                  let createList = dlsym(lib, "MTDeviceCreateList"),
                  let register = dlsym(lib, "MTRegisterContactFrameCallback"),
                  let startDevice = dlsym(lib, "MTDeviceStart"),
                  let stopDevice = dlsym(lib, "MTDeviceStop") else { return }
            createListFn = unsafeBitCast(createList, to: CreateListFn.self)
            registerFn = unsafeBitCast(register, to: RegisterFn.self)
            startFn = unsafeBitCast(startDevice, to: DeviceFn.self)
            stopFn = unsafeBitCast(stopDevice, to: DeviceFn.self)
        }
        guard let list = createListFn?()?.takeRetainedValue() else { return }
        deviceList = list
        for i in 0..<CFArrayGetCount(list) {
            guard let raw = CFArrayGetValueAtIndex(list, i) else { continue }
            let device = UnsafeMutableRawPointer(mutating: raw)
            registerFn?(device, contactCallback)
            startFn?(device, 0)
            devices.append(device)
        }
    }

    func stop() {
        for device in devices { stopFn?(device, 0) }
        devices.removeAll()
        deviceList = nil
        pinchState.lock.lock()
        pinchState.track.removeAll()
        pinchState.lock.unlock()
    }

    func restart() {
        stop()
        start()
    }

    /// Trackpad devices go silent after sleep and the list captured at start
    /// misses trackpads plugged in later, so re-enumerate on wake and poll
    /// slowly for count changes.
    func watchForDeviceChanges() {
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.restart() }

        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            guard let self, let createList = self.createListFn else { return }
            var count = 0
            if let list = createList()?.takeRetainedValue() { count = CFArrayGetCount(list) }
            if count != self.devices.count { self.restart() }
        }
    }
}

private let pinch = MultitouchPinch()
pinch.start()
pinch.watchForDeviceChanges()

DispatchQueue.global().async {
    while readLine() != nil {}

    exit(0)
}

app.run()
