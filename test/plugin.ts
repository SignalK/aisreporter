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
  savedOptions: Array<Record<string, unknown>>
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
  const savedOptions: Array<Record<string, unknown>> = []

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
    savePluginOptions(
      opts: Record<string, unknown>,
      cb?: (err?: Error) => void
    ) {
      savedOptions.push(opts)
      if (cb) cb()
    },
    error: () => undefined,
    debug: () => undefined
  }

  return {
    app,
    buses,
    selfPathValues,
    savedOptions,
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
    position: { latitude: number; longitude: number } | undefined
    sog: number | undefined
    cog: number | undefined
    head: number | undefined
  }> = {},
  debounceWindowMs = 15
) {
  h.buses['navigation.speedOverGround']!.push(sog)
  h.buses['navigation.courseOverGroundTrue']!.push(cog)
  h.buses['navigation.headingTrue']!.push(head)
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
      lastpositionupdate: false
    })
    await pushPositionInputs(h)
    await wait(40)
    plugin.stop()
    await h.close()

    const payloads = h.received.map((b) => b.toString().trim())
    const posReport = payloads.find((p) => p.startsWith('!AIVDM'))
    expect(posReport, 'expected an AIVDM UDP frame').to.exist
  })

  it('sends both static parts on first dynamic when the app has the full design profile', async () => {
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
      updaterate: 0.01,
      staticupdaterate: 999
    })
    await pushPositionInputs(h)
    await wait(40)
    plugin.stop()
    await h.close()

    const payloads = h.received.map((b) => b.toString().trim())
    // Position (type-18) + static part 0 + static part 1 = at least three.
    expect(payloads.length).to.be.at.least(3)
    expect(payloads.every((p) => p.startsWith('!AIVDM'))).to.equal(true)
  })

  it('sends only part 0 when only vessel name is available', async () => {
    const h = await createHarness()
    h.selfPathValues['name'] = 'Only Name'
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
    const payloads = h.received.map((b) => b.toString().trim())
    // Position + part 0. No part 1 because no shipType / no callsign / no
    // full dims.
    expect(payloads.length).to.equal(2)
  })

  it('sends no static when neither name, callsign, nor dims are set', async () => {
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
    await h.close()
    // Only the position frame — no static content to send.
    expect(h.received.length).to.equal(1)
  })

  // Cover every arm of the sendStaticPartOne gate:
  // shipType, dims-only, callsign-only.

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
      updaterate: 0.01,
      staticupdaterate: 999
    })
    await pushPositionInputs(h)
    await wait(30)
    plugin.stop()
    await h.close()
    // Position + static part 0 + static part 1.
    expect(h.received.length).to.equal(3)
  })

  it('sends part 1 when only callsign (no shipType, no full dims) is set', async () => {
    const h = await createHarness()
    h.selfPathValues['name'] = 'Callsign Only'
    h.selfPathValues['communication.callsignVhf'] = 'KSIGN'
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
    // Position + static part 0 + static part 1.
    expect(h.received.length).to.equal(3)
  })

  it('static rebroadcast fires on staticupdaterate after the first dynamic', async () => {
    const h = await createHarness()
    h.selfPathValues['name'] = 'Repeater'
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 0.02
    })
    await pushPositionInputs(h)
    await wait(80)
    plugin.stop()
    await h.close()
    // Position + initial static part 0 (fires on first dynamic) + at
    // least one interval rebroadcast of part 0 = 3+ frames.
    expect(h.received.length).to.be.at.least(3)
  })

  it('resends last known position on lastpositionupdate interval', async () => {
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999,
      lastpositionupdate: true,
      lastpositionupdaterate: 0.015
    })
    await pushPositionInputs(h)
    await wait(80)
    plugin.stop()
    await h.close()
    expect(h.received.length).to.be.at.least(2)
  })

  it('broadcasts to every configured endpoint', async () => {
    const h1 = await createHarness()
    const h2 = await createHarness()
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

  it('restarts cleanly after stop() on the same instance: per-run state (firstDynamicSeen, lastMessages) is reset', async () => {
    const h = await createHarness()
    h.selfPathValues['name'] = 'Reboot'
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999
    })
    await pushPositionInputs(h)
    await wait(30)
    // First run: position + first-dynamic static part 0 = >= 2 frames.
    const firstRunCount = h.received.length
    expect(firstRunCount).to.be.at.least(2)
    plugin.stop()

    // statusMessage slots cleared on stop().
    expect(plugin.statusMessage()).to.equal(
      'Last sent messages: position  Static part 0:  Static part 1: '
    )
    h.received.length = 0

    // Second start() on the SAME instance. If firstDynamicSeen isn't
    // reset, the first-dynamic static would be skipped on this run.
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999
    })
    await pushPositionInputs(h)
    await wait(30)
    plugin.stop()
    await h.close()

    // Same >= 2 frames on the second run, proving firstDynamicSeen was reset.
    expect(h.received.length).to.be.at.least(2)
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
      sog: 1.9438444924574,
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

  it('still encodes position with sog / cog / hdg unset (only position is required)', async () => {
    const h = await createHarness()
    h.selfPathValues['mmsi'] = MMSI
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999
    })
    // Push position only — leave sog / cog / head at their .toProperty
    // seed of undefined. Bypasses pushPositionInputs's numeric defaults.
    h.buses['navigation.position']!.push({ latitude: 10, longitude: 20 })
    await wait(30)
    plugin.stop()
    await h.close()

    const expected: string = new AisEncode({
      aistype: 18,
      repeat: 0,
      mmsi: MMSI,
      sog: undefined,
      accuracy: 0,
      lon: 20,
      lat: 10,
      cog: undefined,
      hdg: undefined
    }).nmea

    const actual = h.received.map((b) => b.toString().trim())
    expect(
      actual,
      `expected a frame equal to ${expected}, got ${JSON.stringify(actual)}`
    ).to.include(expected)
  })

  it('static part 0 encodes shipname bit-for-bit', async () => {
    const h = await createHarness()
    h.selfPathValues['mmsi'] = MMSI
    h.selfPathValues['name'] = 'Aisreporter Test'
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
      updaterate: 0.01,
      staticupdaterate: 999
    })
    await pushPositionInputs(h)
    await wait(30)
    plugin.stop()
    await h.close()

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

  it('different positions each encode to the expected per-position NMEA frame', async () => {
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
      return h.received[h.received.length - 1]!.toString().trim()
    }
    const expectedFor = (lat: number, lon: number): string =>
      new AisEncode({
        aistype: 18,
        repeat: 0,
        mmsi: MMSI,
        sog: 5 * 1.9438444924574,
        accuracy: 0,
        lon,
        lat,
        cog: (0.5 * 180) / Math.PI,
        hdg: (0.7 * 180) / Math.PI
      }).nmea
    expect(await frameFor(10, 20)).to.equal(expectedFor(10, 20))
    expect(await frameFor(-30, 50)).to.equal(expectedFor(-30, 50))
  })

  it('encodes negative fromCenter (starboard-offset GPS) with correct dimC/dimD', async () => {
    const h = await createHarness()
    h.selfPathValues['mmsi'] = MMSI
    h.selfPathValues['name'] = 'Starboard'
    h.selfPathValues['design.length.value.overall'] = 10
    h.selfPathValues['design.beam.value'] = 4
    h.selfPathValues['sensors.gps.fromBow.value'] = 3
    h.selfPathValues['sensors.gps.fromCenter.value'] = -1
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

    const expected: string = new AisEncode({
      aistype: 24,
      repeat: 0,
      part: 1,
      mmsi: MMSI,
      dimA: '3',
      // length - fromBow = 10 - 3 = 7
      dimB: '7',
      // beam / 2 + fromCenter = 2 + (-1) = 1
      dimC: '1',
      // beam / 2 - fromCenter = 2 - (-1) = 3
      dimD: '3'
    }).nmea
    expect(h.received.map((b) => b.toString().trim())).to.include(expected)
  })
})

describe('aisreporter — ignores Null-Island and undefined positions', () => {
  it('drops reports with position (0, 0) entirely', async () => {
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999
    })
    await pushPositionInputs(h, {
      position: { latitude: 0, longitude: 0 }
    })
    await wait(40)
    plugin.stop()
    await h.close()
    expect(h.received.length).to.equal(0)
  })

  it('drops reports with near-zero position (GPS noise)', async () => {
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999
    })
    await pushPositionInputs(h, {
      position: { latitude: 1e-9, longitude: -1e-9 }
    })
    await wait(40)
    plugin.stop()
    await h.close()
    expect(h.received.length).to.equal(0)
  })

  it('drops reports with undefined position', async () => {
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999
    })
    h.buses['navigation.speedOverGround']!.push(1)
    h.buses['navigation.courseOverGroundTrue']!.push(0.5)
    h.buses['navigation.headingTrue']!.push(0.7)
    await wait(15)
    h.buses['navigation.position']!.push(undefined)
    await wait(40)
    plugin.stop()
    await h.close()
    expect(h.received.length).to.equal(0)
  })

  it('still emits reports for valid positions just outside the Null-Island window', async () => {
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999
    })
    await pushPositionInputs(h, {
      position: { latitude: 0.01, longitude: 0.01 }
    })
    await wait(40)
    plugin.stop()
    await h.close()
    expect(h.received.length).to.be.at.least(1)
  })
})

describe('aisreporter — gates static on recent dynamic', () => {
  it('does not send any static report before the first dynamic arrives', async () => {
    const h = await createHarness()
    h.selfPathValues['name'] = 'Idle'
    h.selfPathValues['communication.callsignVhf'] = 'IDLE'
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 999,
      staticupdaterate: 0.01
    })
    // Deliberately do NOT push a position. Give the static-interval a
    // generous window to fire repeatedly and confirm it stays silent.
    await wait(60)
    plugin.stop()
    await h.close()
    expect(h.received.length).to.equal(0)
  })

  it('fires static once the first dynamic arrives, then keeps rebroadcasting', async () => {
    const h = await createHarness()
    h.selfPathValues['name'] = 'Waking Up'
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 0.02
    })
    // Wait through a static-interval cycle with no dynamic → no frames.
    await wait(30)
    expect(h.received.length).to.equal(0)

    // Push a position. Expect: position frame + initial static part 0 +
    // at least one interval rebroadcast.
    await pushPositionInputs(h)
    await wait(80)
    plugin.stop()
    await h.close()
    expect(h.received.length).to.be.at.least(3)
  })
})

describe('aisreporter — legacy config-key migration', () => {
  it('reads the legacy lastpositonupdate key when the corrected one is absent', async () => {
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999,
      // Old, typo'd key. Expect the plugin to honour it.
      lastpositonupdate: true,
      lastpositonupdaterate: 0.015
    })
    await pushPositionInputs(h)
    await wait(80)
    plugin.stop()
    await h.close()
    // Original position + at least one last-known resend.
    expect(h.received.length).to.be.at.least(2)
  })

  it('prefers the corrected key when both are set', async () => {
    // Sanity: if the corrected key disables the resend, no resends fire
    // even though the legacy key says to enable them.
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999,
      lastpositionupdate: false,
      lastpositonupdate: true,
      lastpositionupdaterate: 0.015,
      lastpositonupdaterate: 0.015
    })
    await pushPositionInputs(h)
    await wait(50)
    plugin.stop()
    await h.close()
    // Only the original position — no resend timer because
    // lastpositionupdate: false wins.
    expect(h.received.length).to.equal(1)
  })

  it('persists the migration via app.savePluginOptions when legacy keys are present', async () => {
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 999,
      staticupdaterate: 999,
      lastpositonupdate: true,
      lastpositonupdaterate: 180
    })
    plugin.stop()
    await h.close()

    expect(h.savedOptions.length).to.equal(1)
    const persisted = h.savedOptions[0]!
    expect(persisted.lastpositionupdate).to.equal(true)
    expect(persisted.lastpositionupdaterate).to.equal(180)
    // Legacy keys stripped from the persisted payload.
    expect(persisted).to.not.have.property('lastpositonupdate')
    expect(persisted).to.not.have.property('lastpositonupdaterate')
  })

  it('does not call savePluginOptions when only the corrected keys are present', async () => {
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 999,
      staticupdaterate: 999,
      lastpositionupdate: true,
      lastpositionupdaterate: 180
    })
    plugin.stop()
    await h.close()
    expect(h.savedOptions.length).to.equal(0)
  })

  it('does not crash when savePluginOptions is absent on older servers', async () => {
    const h = await createHarness()
    delete (h.app as any).savePluginOptions
    const plugin = createPlugin(h.app)
    expect(() =>
      plugin.start({
        endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
        updaterate: 999,
        staticupdaterate: 999,
        lastpositonupdate: true
      })
    ).to.not.throw()
    plugin.stop()
    await h.close()
  })

  it('surfaces savePluginOptions callback errors through debug (does not throw)', async () => {
    const debugMsgs: string[] = []
    const h = await createHarness()
    h.app.debug = (m: string) => debugMsgs.push(m)
    h.app.savePluginOptions = (_opts: unknown, cb?: (err?: Error) => void) => {
      if (cb) cb(new Error('disk full'))
    }
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 999,
      staticupdaterate: 999,
      lastpositonupdate: true
    })
    plugin.stop()
    await h.close()
    expect(debugMsgs.some((m) => m.includes('migration save failed'))).to.equal(
      true
    )
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
    const msg = plugin.statusMessage()
    plugin.stop()
    await h.close()
    expect(msg).to.equal(
      'Last sent messages: position  Static part 0:  Static part 1: '
    )
  })

  it('schema advertises the corrected lastpositionupdate keys', () => {
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
    expect(schema.properties.lastpositionupdaterate).to.deep.include({
      type: 'number',
      default: 180
    })
    expect(schema.properties.lastpositionupdate).to.deep.include({
      type: 'boolean',
      default: false
    })
    // Typo'd keys are no longer advertised in the schema; they're still
    // accepted at runtime via the migration path but the UI should only
    // show the corrected names.
    expect(schema.properties).to.not.have.property('lastpositonupdate')
    expect(schema.properties).to.not.have.property('lastpositonupdaterate')
  })
})

describe('aisreporter lastpositionupdate timer lifecycle', () => {
  it('clears the prior last-position timer before arming a new one on each fresh position', async () => {
    // Spy on setInterval/clearInterval to prove the clearInterval on a
    // prior timer id is actually invoked before the second setInterval.
    const origSetInterval = global.setInterval
    const origClearInterval = global.clearInterval
    const armedIds: NodeJS.Timeout[] = []
    const clearedIds: NodeJS.Timeout[] = []
    global.setInterval = ((fn: () => void, ms: number) => {
      const id = origSetInterval(fn, ms)
      armedIds.push(id)
      return id
    }) as typeof global.setInterval
    global.clearInterval = ((id: NodeJS.Timeout) => {
      clearedIds.push(id)
      return origClearInterval(id)
    }) as typeof global.clearInterval

    try {
      const h = await createHarness()
      const plugin = createPlugin(h.app)
      plugin.start({
        endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
        updaterate: 0.01,
        staticupdaterate: 999,
        lastpositionupdate: true,
        lastpositionupdaterate: 0.02
      })
      const armedBefore = armedIds.length
      await pushPositionInputs(h, {
        position: { latitude: 10, longitude: 20 }
      })
      await wait(30)
      const firstLastPosTimer = armedIds[armedIds.length - 1]!
      await pushPositionInputs(h, {
        position: { latitude: 40, longitude: 50 }
      })
      await wait(30)
      plugin.stop()
      await h.close()

      // Two setInterval calls for last-position (one per onValue), plus
      // the static-interval armed at start. Confirm the first
      // last-position timer id was cleared by the second onValue.
      expect(armedIds.length).to.be.greaterThan(armedBefore + 1)
      expect(clearedIds).to.include(firstLastPosTimer)
    } finally {
      global.setInterval = origSetInterval
      global.clearInterval = origClearInterval
    }
  })
})

describe('aisreporter — STATIC_MAX_STALE_MS inactivity gate', () => {
  it('stops rebroadcasting static reports once the last dynamic is older than 10 minutes', async () => {
    const origNow = Date.now
    try {
      const t0 = origNow()
      let clock = t0
      // Freeze Date.now while the first dynamic is captured so
      // lastDynamicAt lands on our controlled epoch.
      Date.now = () => clock

      const h = await createHarness()
      h.selfPathValues['name'] = 'Stale'
      const plugin = createPlugin(h.app)
      plugin.start({
        endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
        updaterate: 0.01,
        staticupdaterate: 0.02,
        lastpositionupdate: false
      })
      await pushPositionInputs(h)
      await wait(30)
      // Frames so far: position + first-dynamic static part 0 plus
      // at least one interval rebroadcast.
      const beforeStale = h.received.length
      expect(beforeStale).to.be.at.least(2)

      // Jump the clock past STATIC_MAX_STALE_MS (10 min). The static
      // interval keeps ticking every 20 ms but the gate should refuse
      // to send any further frame.
      clock = t0 + 10 * 60 * 1000 + 1
      // Drain any UDP packet that was already in flight at the moment
      // the clock flipped — socket.send is async and the receiver may
      // not have seen it yet.
      await wait(40)
      const frozen = h.received.length
      // Second window: every interval tick here sees the stale clock
      // and must bail. Frame count should not change.
      await wait(80)
      plugin.stop()
      await h.close()

      expect(h.received.length).to.equal(frozen)
    } finally {
      Date.now = origNow
    }
  })
})

describe('aisreporter — default rate fallbacks', () => {
  it('applies staticupdaterate default of 360s when the prop is omitted', async () => {
    const origSetInterval = global.setInterval
    const delays: number[] = []
    global.setInterval = ((fn: () => void, ms: number) => {
      delays.push(ms)
      return origSetInterval(fn, ms)
    }) as typeof global.setInterval
    try {
      const h = await createHarness()
      const plugin = createPlugin(h.app)
      plugin.start({
        endpoints: [{ ipaddress: '127.0.0.1', port: h.port }]
      })
      plugin.stop()
      await h.close()
      // Static interval is the only one armed at start() time.
      expect(delays).to.include(360 * 1000)
    } finally {
      global.setInterval = origSetInterval
    }
  })

  it('applies lastpositionupdaterate default of 180s when the prop is omitted', async () => {
    const origSetInterval = global.setInterval
    const delays: number[] = []
    global.setInterval = ((fn: () => void, ms: number) => {
      delays.push(ms)
      return origSetInterval(fn, ms)
    }) as typeof global.setInterval
    try {
      const h = await createHarness()
      const plugin = createPlugin(h.app)
      plugin.start({
        endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
        updaterate: 0.01,
        staticupdaterate: 999,
        lastpositionupdate: true
      })
      await pushPositionInputs(h)
      await wait(30)
      plugin.stop()
      await h.close()
      expect(delays).to.include(180 * 1000)
    } finally {
      global.setInterval = origSetInterval
    }
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
    const origErr = console.error
    const origLog = console.log
    console.error = () => undefined
    console.log = () => undefined
    try {
      const h = await createHarness()
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
    expect(() => plugin.stop()).to.not.throw()
  })

  it('start() with no endpoints key in props does not throw on subsequent position', async () => {
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    // Deliberately omit `endpoints` — simulates a user saving config
    // through the web UI without populating the endpoints array.
    plugin.start({
      updaterate: 0.01,
      staticupdaterate: 999
    })
    // Pushing a position exercises the onValue handler that calls
    // cfg.endpoints.forEach; also exercises sendStaticPart0/1 paths.
    h.selfPathValues['name'] = 'NoEndpoints'
    await pushPositionInputs(h)
    await wait(30)
    plugin.stop()
    await h.close()
    // Nothing was configured to receive, so nothing was sent.
    expect(h.received.length).to.equal(0)
  })

  it('start() swallows errors thrown during subscription setup and leaves started=false', async () => {
    const h = await createHarness()
    const origErr = console.error
    console.error = () => undefined
    try {
      // Replace getSelfStream so combineWith setup throws.
      h.app.streambundle.getSelfStream = () => {
        throw new Error('stream setup boom')
      }
      const plugin = createPlugin(h.app)
      expect(() =>
        plugin.start({
          endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
          updaterate: 0.01,
          staticupdaterate: 999
        })
      ).to.not.throw()
      expect(plugin.started).to.equal(false)
      plugin.stop()
    } finally {
      console.error = origErr
      await h.close()
    }
  })

  it('stop() clears the lastMessages status slots so a subsequent start() starts fresh', async () => {
    const h = await createHarness()
    h.selfPathValues['name'] = 'Clearable'
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      updaterate: 0.01,
      staticupdaterate: 999
    })
    await pushPositionInputs(h)
    await wait(30)
    // After a run, statusMessage has content in every slot.
    expect(plugin.statusMessage()).to.not.equal(
      'Last sent messages: position  Static part 0:  Static part 1: '
    )
    plugin.stop()
    await h.close()
    // After stop(), slots are blank again — no stale frames carried
    // over into the next run.
    expect(plugin.statusMessage()).to.equal(
      'Last sent messages: position  Static part 0:  Static part 1: '
    )
  })
})
