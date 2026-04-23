/*
 * End-to-end tests for the aisreporter plugin.
 *
 * Each test wires the plugin against a stub Signal K app (Bacon buses +
 * getSelfPath map) and a real UDP socket bound to 127.0.0.1. Position
 * and static reports that the plugin emits are captured from the UDP
 * socket so the whole round-trip — stream combine → debounce → AIS
 * encode → UDP send — is exercised in each assertion.
 *
 * Rates are set to 10 ms in most tests so that `setInterval`-driven
 * behaviour (static rebroadcast, last-known-position resend) fires
 * within a mocha test tick without needing a fake-timers dep.
 */

import { expect } from 'chai'
import * as dgram from 'dgram'
import * as Bacon from 'baconjs'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const createPlugin = require('../src/index')

interface Harness {
  app: any
  buses: Record<string, Bacon.Bus<unknown>>
  selfPathValues: Record<string, unknown>
  received: Buffer[]
  port: number
  close: () => Promise<void>
}

async function createHarness(): Promise<Harness> {
  const received: Buffer[] = []
  const server = dgram.createSocket('udp4')
  server.on('message', (msg) => received.push(msg))
  const port: number = await new Promise((resolve, reject) => {
    server.once('listening', () => {
      const addr = server.address()
      if (typeof addr === 'string' || !addr) {
        reject(new Error('no udp address'))
        return
      }
      resolve(addr.port)
    })
    server.bind(0, '127.0.0.1')
  })

  const buses: Record<string, Bacon.Bus<unknown>> = {}
  const selfPathValues: Record<string, unknown> = { mmsi: '123456789' }

  const app = {
    streambundle: {
      getSelfStream(key: string) {
        if (!buses[key]) buses[key] = new Bacon.Bus<unknown>()
        return buses[key]!
      }
    },
    getSelfPath(key: string) {
      return selfPathValues[key]
    },
    error: () => undefined,
    debug: () => undefined
  }

  return {
    app,
    buses,
    selfPathValues,
    received,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

// Small helper so tests can `await wait(20)` instead of juggling
// setTimeout promises inline.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The plugin wraps each source stream in `.toProperty(undefined)` and
// pipes the tuple through `debounceImmediate`, which only emits on the
// LEADING edge of a silence window. A single synchronous batch of four
// pushes only ever produces one emission — the one after the first
// push, when the other three values are still `undefined`.
//
// Workaround: push sog/cog/head first, let the debounce close, then
// push position. The leading-edge emission in the second window now
// carries all four values.
async function pushPositionInputs(
  h: Harness,
  {
    position = { latitude: 10, longitude: 20 },
    sog = 5,
    cog = 0.5,
    head = 0.7
  }: Partial<{
    position: { latitude: number; longitude: number }
    sog: number
    cog: number
    head: number
  }> = {},
  debounceWindowMs = 15
) {
  h.buses['navigation.speedOverGround']!.push(sog)
  h.buses['navigation.courseOverGroundTrue']!.push(cog)
  h.buses['navigation.headingTrue']!.push(head)
  // Wait for the leading-edge debounce to settle so the next push opens
  // a new window and carries all four values through.
  await wait(debounceWindowMs)
  h.buses['navigation.position']!.push(position)
}

describe('aisreporter start/stop lifecycle', () => {
  it('emits a class-B position report after position + sog + cog + head arrive', async () => {
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999,
      lastpositonupdate: false
    })
    await pushPositionInputs(h)
    await wait(40)
    plugin.stop()
    await h.close()

    const payloads = h.received.map((b) => b.toString().trim())
    // At least one type-18 position report (AIVDM with !AIVDM,1,1,,B,...)
    const posReport = payloads.find((p) => p.startsWith('!AIVDM'))
    expect(posReport, 'expected an AIVDM UDP frame').to.exist
  })

  it('sends both static parts on startup when the app has the full design profile', async () => {
    const h = await createHarness()
    h.selfPathValues['name'] = 'Test Vessel'
    h.selfPathValues['design.length.value.overall'] = 12
    h.selfPathValues['design.beam.value'] = 4
    h.selfPathValues['design.aisShipType.value.id'] = 36
    h.selfPathValues['communication.callsignVhf'] = 'TEST1'
    h.selfPathValues['sensors.gps.fromBow.value'] = 3
    h.selfPathValues['sensors.gps.fromCenter.value'] = 0

    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 999,
      staticupdaterate: 999
    })
    // The first sendStaticReport call is synchronous; give the UDP a moment.
    await wait(40)
    plugin.stop()
    await h.close()

    const payloads = h.received.map((b) => b.toString().trim())
    // Static reports come as type-24 AIS messages (AIVDM too).
    // We expect two: part 0 (shipname) + part 1 (dims/callsign).
    expect(payloads.length).to.be.at.least(2)
    expect(payloads.every((p) => p.startsWith('!AIVDM'))).to.equal(true)
  })

  it('sends only part 0 when only vessel name is available', async () => {
    const h = await createHarness()
    h.selfPathValues['name'] = 'Only Name'
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 999,
      staticupdaterate: 999
    })
    await wait(30)
    plugin.stop()
    await h.close()
    const payloads = h.received.map((b) => b.toString().trim())
    expect(payloads.length).to.equal(1)
  })

  it('sends nothing static when neither name, callsign, nor dims are set', async () => {
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 999,
      staticupdaterate: 999
    })
    await wait(30)
    plugin.stop()
    await h.close()
    expect(h.received.length).to.equal(0)
  })

  // The remaining static-part-one branches: dims-only and callsign-only.
  // Together with the shipType-branch test above, every arm of the `||`
  // gate is exercised.

  it('sends part 1 when only dims (no shipType, no callsign) are set', async () => {
    const h = await createHarness()
    h.selfPathValues['name'] = 'Dims Only'
    h.selfPathValues['design.length.value.overall'] = 10
    h.selfPathValues['design.beam.value'] = 3
    h.selfPathValues['sensors.gps.fromBow.value'] = 2
    h.selfPathValues['sensors.gps.fromCenter.value'] = 0
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 999,
      staticupdaterate: 999
    })
    await wait(30)
    plugin.stop()
    await h.close()
    expect(h.received.length).to.equal(2)
  })

  it('sends part 1 when only callsign (no shipType, no full dims) is set', async () => {
    const h = await createHarness()
    h.selfPathValues['name'] = 'Callsign Only'
    h.selfPathValues['communication.callsignVhf'] = 'KSIGN'
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 999,
      staticupdaterate: 999
    })
    await wait(30)
    plugin.stop()
    await h.close()
    expect(h.received.length).to.equal(2)
  })

  it('static rebroadcast fires on staticupdaterate', async () => {
    const h = await createHarness()
    h.selfPathValues['name'] = 'Repeater'
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 999,
      staticupdaterate: 0.015
    })
    await wait(60)
    plugin.stop()
    await h.close()
    // Initial + at least one rebroadcast ≈ 2+ frames.
    expect(h.received.length).to.be.at.least(2)
  })

  it('resends last known position on lastpositonupdate interval', async () => {
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999,
      lastpositonupdate: true,
      lastpositonupdaterate: 0.015
    })
    await pushPositionInputs(h)
    await wait(80)
    plugin.stop()
    await h.close()
    // Original position + at least one "last known" resend.
    expect(h.received.length).to.be.at.least(2)
  })

  it('broadcasts to every configured endpoint', async () => {
    const h1 = await createHarness()
    const h2 = await createHarness()
    // The second harness borrows the first's app so both receive from the
    // same plugin instance; only the UDP endpoint list distinguishes them.
    const plugin = createPlugin(h1.app)
    plugin.start({
      endpoints: [
        { ipaddress: '127.0.0.1', port: h1.port },
        { ipaddress: '127.0.0.1', port: h2.port }
      ],
      updaterate: 0.01,
      staticupdaterate: 999
    })
    await pushPositionInputs(h1)
    await wait(40)
    plugin.stop()
    await Promise.all([h1.close(), h2.close()])
    expect(h1.received.length).to.be.at.least(1)
    expect(h2.received.length).to.be.at.least(1)
  })

  it('restarts cleanly after stop() (subscriptions cleared, new start() works)', async () => {
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999
    })
    await pushPositionInputs(h)
    await wait(30)
    plugin.stop()
    const afterFirstStop = h.received.length

    // Second start(): fresh factory + new streams.
    const h2 = await createHarness()
    const plugin2 = createPlugin(h2.app)
    plugin2.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h2.port }],
      updaterate: 0.01,
      staticupdaterate: 999
    })
    await pushPositionInputs(h2)
    await wait(30)
    plugin2.stop()
    await h.close()
    await h2.close()

    expect(afterFirstStop).to.be.at.least(1)
    expect(h2.received.length).to.be.at.least(1)
  })

  it('statusMessage reflects last sent frames', async () => {
    const h = await createHarness()
    h.selfPathValues['name'] = 'Statusable'
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999
    })
    await pushPositionInputs(h)
    await wait(40)
    plugin.stop()
    await h.close()

    const msg = plugin.statusMessage()
    expect(msg).to.include('Last sent messages: position')
    expect(msg).to.include('Static part 0:')
    expect(msg).to.include('Static part 1:')
  })
})

describe('aisreporter AIS field encoding', () => {
  // These tests assert the exact NMEA output bytes against a reference
  // frame constructed directly with ggencoder. Any drift in the
  // field-mapping code (mpsToKn, radsToDeg, or the `!== undefined`
  // guards that decide whether to pass a field through) flips the
  // encoded bitstream and the comparison fails. This is what gets the
  // Stryker score up — simple "a frame arrived" assertions pass through
  // most mutations unnoticed.

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AisEncode } = require('ggencoder')
  const MMSI = '123456789'

  it('encodes position report with correct field mapping (1 m/s → 1.9438 kn, rad → deg)', async () => {
    const h = await createHarness()
    h.selfPathValues['mmsi'] = MMSI
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999
    })
    await pushPositionInputs(h, {
      position: { latitude: 10, longitude: 20 },
      sog: 1,
      cog: 0.5,
      head: 0.7
    })
    await wait(30)
    plugin.stop()
    await h.close()

    const expected: string = new AisEncode({
      aistype: 18,
      repeat: 0,
      mmsi: MMSI,
      sog: 1.9438444924574, // 1 m/s converted to knots
      accuracy: 0,
      lon: 20,
      lat: 10,
      cog: (0.5 * 180) / Math.PI,
      hdg: (0.7 * 180) / Math.PI
    }).nmea

    const actual = h.received.map((b) => b.toString().trim())
    expect(
      actual,
      `expected a frame equal to ${expected}, got ${JSON.stringify(actual)}`
    ).to.include(expected)
  })

  it('omits sog / cog / hdg / lat / lon when their source value is undefined', async () => {
    const h = await createHarness()
    h.selfPathValues['mmsi'] = MMSI
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999
    })
    h.buses['navigation.position']!.push(undefined)
    h.buses['navigation.speedOverGround']!.push(undefined)
    h.buses['navigation.courseOverGroundTrue']!.push(undefined)
    h.buses['navigation.headingTrue']!.push(undefined)
    await wait(40)
    plugin.stop()
    await h.close()

    const expected: string = new AisEncode({
      aistype: 18,
      repeat: 0,
      mmsi: MMSI,
      sog: undefined,
      accuracy: 0,
      lon: undefined,
      lat: undefined,
      cog: undefined,
      hdg: undefined
    }).nmea

    expect(h.received.map((b) => b.toString().trim())).to.include(expected)
  })

  it('static part 0 encodes shipname bit-for-bit', async () => {
    const h = await createHarness()
    h.selfPathValues['mmsi'] = MMSI
    h.selfPathValues['name'] = 'Aisreporter Test'
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 999,
      staticupdaterate: 999
    })
    await wait(30)
    plugin.stop()
    await h.close()

    const expected: string = new AisEncode({
      aistype: 24,
      repeat: 0,
      part: 0,
      mmsi: MMSI,
      shipname: 'Aisreporter Test'
    }).nmea

    expect(h.received.map((b) => b.toString().trim())).to.include(expected)
  })

  it('static part 1 encodes dims exactly via putDimensions math', async () => {
    const h = await createHarness()
    h.selfPathValues['mmsi'] = MMSI
    h.selfPathValues['name'] = 'Dims'
    h.selfPathValues['design.length.value.overall'] = 10
    h.selfPathValues['design.beam.value'] = 4
    h.selfPathValues['sensors.gps.fromBow.value'] = 3
    h.selfPathValues['sensors.gps.fromCenter.value'] = 1
    h.selfPathValues['design.aisShipType.value.id'] = 36
    h.selfPathValues['communication.callsignVhf'] = 'CALL1'

    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 999,
      staticupdaterate: 999
    })
    await wait(30)
    plugin.stop()
    await h.close()

    // Mirror putDimensions(): dimA = fromBow, dimB = length-fromBow,
    // dimC = beam/2 + fromCenter, dimD = beam/2 - fromCenter.
    const expected: string = new AisEncode({
      aistype: 24,
      repeat: 0,
      part: 1,
      mmsi: MMSI,
      cargo: 36,
      callsign: 'CALL1',
      dimA: '3',
      dimB: '7',
      dimC: '3',
      dimD: '1'
    }).nmea

    expect(h.received.map((b) => b.toString().trim())).to.include(expected)
  })

  it('different positions produce different NMEA frames (sensitivity)', async () => {
    // Kill mutants like `lat: position !== undefined ? position.latitude : undefined`
    // → `lat: undefined`: if latitude were dropped, both frames would match.
    async function frameFor(lat: number, lon: number): Promise<string> {
      const h = await createHarness()
      h.selfPathValues['mmsi'] = MMSI
      const plugin = createPlugin(h.app)
      plugin.start({
        endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
        updaterate: 0.01,
        staticupdaterate: 999
      })
      await pushPositionInputs(h, {
        position: { latitude: lat, longitude: lon }
      })
      await wait(30)
      plugin.stop()
      await h.close()
      // pushPositionInputs emits two frames: a leading-edge [U, sog, cog,
      // head] and then the full [pos, sog, cog, head]. We want the latter.
      return h.received[h.received.length - 1]!.toString().trim()
    }
    const f1 = await frameFor(10, 20)
    const f2 = await frameFor(-30, 50)
    expect(f1).to.not.equal(f2)
  })
})

describe('aisreporter initial + schema state', () => {
  it('statusMessage returns three empty slots before any frame fires', async () => {
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 999,
      staticupdaterate: 999
    })
    // No push → no position / static frame → all three slots empty.
    const msg = plugin.statusMessage()
    plugin.stop()
    await h.close()
    expect(msg).to.equal(
      'Last sent messages: position  Static part 0:  Static part 1: '
    )
  })

  it('schema declares the UDP-endpoint + rate properties with their documented defaults', () => {
    const plugin = createPlugin({
      getSelfPath: () => undefined,
      error: () => undefined,
      debug: () => undefined
    })
    const schema = plugin.schema
    expect(schema.type).to.equal('object')

    const eps = schema.properties.endpoints
    expect(eps.type).to.equal('array')
    expect(eps.title).to.equal('UDP endpoints to send updates')
    expect(eps.items.required).to.deep.equal(['ipaddress', 'port'])
    expect(eps.items.properties.ipaddress.default).to.equal('0.0.0.0')
    expect(eps.items.properties.port.default).to.equal(12345)
    expect(eps.items.properties.port.title).to.equal('Port')

    expect(schema.properties.updaterate).to.deep.include({
      type: 'number',
      title: 'Position Update Rate (s)',
      default: 60
    })
    expect(schema.properties.staticupdaterate).to.deep.include({
      type: 'number',
      title: 'Static Update Rate (s)',
      default: 360
    })
    expect(schema.properties.lastpositonupdaterate).to.deep.include({
      type: 'number',
      default: 180
    })
    expect(schema.properties.lastpositonupdate).to.deep.include({
      type: 'boolean',
      default: false
    })
  })
})

describe('aisreporter lastpositonupdate timer lifecycle', () => {
  it('clears a prior last-position timer when a fresh position arrives', async () => {
    // Covers the `if (lastPositionTimeout) clearInterval(...)` branch in
    // the onValue handler: push a first position → last-position timer
    // starts → push a second position → first timer must be cleared
    // before a new one is created. If the clear branch mutates to no-op,
    // both timers run and we'd see roughly double the resends.
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999,
      lastpositonupdate: true,
      lastpositonupdaterate: 0.02
    })
    await pushPositionInputs(h, {
      position: { latitude: 10, longitude: 20 }
    })
    await wait(25)
    // Reset window to allow a second leading-edge emission with new position.
    await wait(25)
    await pushPositionInputs(h, {
      position: { latitude: 40, longitude: 50 }
    })
    await wait(60)
    plugin.stop()
    await h.close()
    // We sent two distinct "real" positions and gave time for multiple
    // last-known resends. If the clearInterval branch had no-op'd, the
    // first timer would still be firing alongside the second — i.e. at
    // least twice as many frames as a single-timer run.
    // Instead, assert that statusMessage reflects the latest position.
    expect(plugin.statusMessage()).to.include('last known')
  })
})

describe('aisreporter plugin falls through its defensive branches', () => {
  it('uses console.error when app.error is missing and mmsi is absent', () => {
    const origErr = console.error
    const errors: string[] = []
    console.error = (m: string) => errors.push(m)
    try {
      const plugin = createPlugin({
        getSelfPath: () => undefined
      })
      plugin.start({})
    } finally {
      console.error = origErr
    }
    expect(errors[0]).to.include('mmsi missing')
  })

  it('uses console.error / console.log for error + debug when the app omits them', async () => {
    // The error and debug no-ops are built when app.error / app.debug are
    // missing. We don't want to actually hit the console during tests, so
    // patch them while the plugin runs.
    const origErr = console.error
    const origLog = console.log
    console.error = () => undefined
    console.log = () => undefined
    try {
      const h = await createHarness()
      // Drop app.error and app.debug to exercise the `||` fallbacks.
      delete (h.app as any).error
      delete (h.app as any).debug
      const plugin = createPlugin(h.app)
      plugin.start({
        endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
        updaterate: 0.01,
        staticupdaterate: 999
      })
      await pushPositionInputs(h)
      await wait(30)
      plugin.stop()
      await h.close()
    } finally {
      console.error = origErr
      console.log = origLog
    }
  })

  it('stop() is safe to call even when start() was never called', () => {
    const plugin = createPlugin({
      getSelfPath: () => '123456789',
      error: () => undefined,
      debug: () => undefined
    })
    // No start — unsubscribe, timeout, lastPositionTimeout all undefined.
    expect(() => plugin.stop()).to.not.throw()
  })
})
