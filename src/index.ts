/*
 * Copyright 2016 Teppo Kurki <teppo.kurki@iki.fi>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { AisEncode } from 'ggencoder'
import * as dgram from 'dgram'
import type { Plugin, Position, ServerAPI } from '@signalk/server-api'

// Some GPS / chartplotter sources emit (0, 0) as a sentinel when they
// have no fix (e.g. while powering down), and Signal K has no explicit
// validity flag. Treat a near-zero pair as "no position" so aggregators
// don't see the vessel parked at Null Island. 1e-6 degrees is ~11 cm
// at the equator — anything below that is GPS-noise around zero, not a
// real fix.
const NULL_ISLAND_EPSILON_DEG = 1e-6
function isNullIsland(position: Position): boolean {
  return (
    Math.abs(position.latitude) < NULL_ISLAND_EPSILON_DEG &&
    Math.abs(position.longitude) < NULL_ISLAND_EPSILON_DEG
  )
}

// Maximum age of the last dynamic (position) reading before static
// reports stop firing. An idle server without a GPS feed must not keep
// pinging aggregators with ghost static data.
const STATIC_MAX_STALE_MS = 10 * 60 * 1000

// AIS true-heading field (type 18/1/2/3): 9-bit integer degrees with 511
// reserved for "heading not available". We must send 511 explicitly when
// we have no heading. ggencoder otherwise substitutes COG for a missing
// heading, which paints the vessel pointing along its course even when
// the real heading differs (current set, leeway, sternway) — up to 180
// degrees wrong. A Class B target with no heading sensor is expected to
// report 511, not a faked course.
const AIS_HEADING_NOT_AVAILABLE = 511

// Earlier schema versions persisted these typo'd keys, so existing
// users have them baked into their `plugin-config-data/aisreporter.json`.
// We publish the corrected keys, read either spelling (new wins), and —
// on servers that support app.savePluginOptions — rewrite the config
// in-place so persisted settings migrate without user input.
const LEGACY_KEYS: Readonly<Record<string, string>> = {
  lastpositonupdate: 'lastpositionupdate',
  lastpositonupdaterate: 'lastpositionupdaterate'
}

// Keep operator-typo configs (NaN, negatives, strings) from arming a
// pathologically tight setInterval that hammers aggregators. A 0 from
// the schema is treated as "use default" rather than "send constantly".
function sanitizeRateSeconds(value: unknown, defaultSeconds: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return defaultSeconds
  }
  return value
}

// Drop endpoints whose ipaddress or port can't be safely passed to
// dgram.send. The schema only types these loosely (string + number); a
// hand-edited config file or future schema relaxation could let through
// objects, empty strings, fractional ports, or values containing
// CR/LF that would smear the log lines we emit alongside each send.
function sanitizeEndpoints(
  endpoints: unknown,
  warn: (msg: string) => void
): Endpoint[] {
  if (!Array.isArray(endpoints)) return []
  const result: Endpoint[] = []
  for (const ep of endpoints) {
    if (!ep || typeof ep !== 'object') {
      warn(
        `aisreporter: ignoring endpoint, not an object: ${JSON.stringify(ep)}`
      )
      continue
    }
    const candidate = ep as { ipaddress?: unknown; port?: unknown }
    if (
      typeof candidate.ipaddress !== 'string' ||
      candidate.ipaddress.length === 0 ||
      /[\r\n]/.test(candidate.ipaddress)
    ) {
      warn(
        `aisreporter: ignoring endpoint with invalid ipaddress: ${JSON.stringify(candidate.ipaddress)}`
      )
      continue
    }
    if (
      typeof candidate.port !== 'number' ||
      !Number.isInteger(candidate.port) ||
      candidate.port < 1 ||
      candidate.port > 65535
    ) {
      warn(
        `aisreporter: ignoring endpoint with invalid port: ${JSON.stringify(candidate.port)}`
      )
      continue
    }
    result.push({ ipaddress: candidate.ipaddress, port: candidate.port })
  }
  return result
}

const createPlugin = function (app: ServerAPI) {
  const error =
    app.error ||
    ((msg: string) => {
      console.error(msg)
    })
  const debug =
    app.debug ||
    ((msg: string) => {
      console.log(msg)
    })

  let udpSocket: dgram.Socket | undefined
  let dynamicTimer: NodeJS.Timeout | undefined
  let staticTimer: NodeJS.Timeout | undefined
  let lastPositionTimer: NodeJS.Timeout | undefined
  const lastMessages: [string, string, string] = ['', '', '']
  let lastMsgNmea: string
  let lastDynamicAt: number | undefined
  let firstDynamicSeen = false
  // Surfaces a misconfigured/disabled state through statusMessage() so
  // the SignalK admin UI doesn't silently show "Last sent messages: ..."
  // with empty slots while the plugin is in fact disabled because of a
  // missing mmsi or an outdated server.
  let lastStartError: string | undefined

  const plugin: Plugin & { started: boolean } = {
    start: function (props: any) {
      lastStartError = undefined
      if (!app.getSelfPath) {
        const msg =
          'aisreporter not started: server too old (no app.getSelfPath)'
        error(msg)
        lastStartError = msg
        plugin.started = false
        return
      }
      const mmsi = app.getSelfPath('mmsi') as string | undefined

      if (!mmsi) {
        const msg = 'aisreporter not started: mmsi missing in settings'
        error(msg)
        lastStartError = msg
        plugin.started = false
        return
      }

      const cfg = migrateLegacyKeys(props, app, debug)
      cfg.endpoints = sanitizeEndpoints(cfg.endpoints, error)
      const updateRateSec = sanitizeRateSeconds(cfg.updaterate, 60)
      const staticRateSec = sanitizeRateSeconds(cfg.staticupdaterate, 360)
      const lastPositionRateSec = sanitizeRateSeconds(
        cfg.lastpositionupdaterate,
        180
      )

      udpSocket = dgram.createSocket('udp4')
      // Poll vessel state through the public ServerAPI rather than
      // subscribing to streambundle Bacon streams. The stream-based
      // path silently stalls on hosts that ship a different baconjs
      // version than the plugin's transitive copy: combine-pipelines
      // wire up without error but never emit. Polling sidesteps the
      // dual-Bacon problem entirely and matches the plugin's actual
      // semantics, which are timer-driven (one report per updaterate).
      let lastEmittedLat: number | undefined
      let lastEmittedLon: number | undefined
      const tick = () => {
        const position = app.getSelfPath('navigation.position.value') as
          | Position
          | undefined
        if (position === undefined || isNullIsland(position)) return
        // Skip when lat/lon haven't moved since the previous emission.
        // Without this, a host whose tree is updated by deltas of the
        // same value (anchored vessel, stuck GPS) would keep firing
        // identical AIS frames at aggregators every tick.
        if (
          position.latitude === lastEmittedLat &&
          position.longitude === lastEmittedLon
        ) {
          return
        }
        const sog = app.getSelfPath('navigation.speedOverGround.value') as
          | number
          | undefined
        const cog = app.getSelfPath('navigation.courseOverGroundTrue.value') as
          | number
          | undefined
        const head = resolveTrueHeadingRad(app)

        const nmea = createPositionReportMessage(
          mmsi,
          position,
          sog,
          cog,
          head
        ).nmea
        lastMessages[0] = new Date().toISOString() + ':' + nmea
        cfg.endpoints.forEach((endpoint: Endpoint) => {
          sendReportMsg(nmea, endpoint.ipaddress, endpoint.port)
        })
        lastMsgNmea = nmea
        lastDynamicAt = Date.now()
        lastEmittedLat = position.latitude
        lastEmittedLon = position.longitude

        // Announce a fresh vessel to aggregators immediately on its
        // first real dynamic reading; subsequent static reports fall
        // to the interval below.
        if (!firstDynamicSeen) {
          firstDynamicSeen = true
          sendStaticReport()
        }

        // Reset the staleness clock on every fresh dynamic — the
        // last-known-position interval represents "time since last
        // real position", not a fixed cadence, so it must restart
        // whenever a new position arrives.
        if (lastPositionTimer) {
          clearInterval(lastPositionTimer)
          lastPositionTimer = undefined
        }
        if (cfg.lastpositionupdate) {
          lastPositionTimer = setInterval(
            sendLastPositionReport,
            lastPositionRateSec * 1000
          )
        }
      }
      dynamicTimer = setInterval(tick, updateRateSec * 1000)

      const sendLastPositionReport = function () {
        lastMessages[0] =
          'last known ' + new Date().toISOString() + ':' + lastMsgNmea
        cfg.endpoints.forEach((endpoint: Endpoint) => {
          sendReportMsg(lastMsgNmea, endpoint.ipaddress, endpoint.port)
        })
      }

      const sendStaticReport = function () {
        if (
          lastDynamicAt === undefined ||
          Date.now() - lastDynamicAt > STATIC_MAX_STALE_MS
        ) {
          return
        }
        const info = getStaticInfo()
        if (Object.keys(info).length) {
          sendStaticPartZero(info, mmsi, cfg.endpoints)
          sendStaticPartOne(info, mmsi, cfg.endpoints)
        }
      }

      staticTimer = setInterval(sendStaticReport, staticRateSec * 1000)
    },

    stop: function () {
      if (dynamicTimer) {
        clearInterval(dynamicTimer)
        dynamicTimer = undefined
      }
      if (staticTimer) {
        clearInterval(staticTimer)
        staticTimer = undefined
      }
      if (lastPositionTimer) {
        clearInterval(lastPositionTimer)
        lastPositionTimer = undefined
      }
      // Without closing the UDP socket, the event loop stays alive after
      // the plugin stops. Matters for tests (mocha won't exit) and for any
      // host that may stop + restart the plugin many times.
      if (udpSocket) {
        udpSocket.close()
        udpSocket = undefined
      }
      // Reset per-run state so a subsequent start() on the same factory
      // instance starts from a clean slate.
      lastDynamicAt = undefined
      firstDynamicSeen = false
      lastMessages[0] = ''
      lastMessages[1] = ''
      lastMessages[2] = ''
      lastStartError = undefined
    },

    statusMessage: function () {
      if (lastStartError !== undefined) return lastStartError
      return `Last sent messages: position ${lastMessages[0]} Static part 0: ${lastMessages[1]} Static part 1: ${lastMessages[2]}`
    },
    started: false,
    id: 'aisreporter',
    name: 'Ais Reporter',
    description:
      "Plugin that reports self's position periodically to Marine Traffic and/or AISHub via UDP AIS messages",
    schema: {
      type: 'object',
      properties: {
        endpoints: {
          type: 'array',
          title: 'UDP endpoints to send updates',
          items: {
            type: 'object',
            required: ['ipaddress', 'port'],
            properties: {
              ipaddress: {
                type: 'string',
                title: 'UDP endpoint IP address',
                default: '0.0.0.0'
              },
              port: {
                type: 'number',
                title: 'Port',
                default: 12345
              }
            }
          }
        },
        updaterate: {
          type: 'number',
          title: 'Position Update Rate (s)',
          default: 60
        },
        staticupdaterate: {
          type: 'number',
          title: 'Static Update Rate (s)',
          default: 360
        },
        lastpositionupdaterate: {
          type: 'number',
          title: 'Last Known Position Update Rate (s)',
          default: 180
        },
        lastpositionupdate: {
          type: 'boolean',
          title:
            'Keep sending last known position when position data is not updated',
          default: false
        }
      }
    }
  }

  return plugin

  function sendReportMsg(msg: string, ip: string, port: number): void {
    debug(ip + ':' + port + ' ' + msg)
    if (udpSocket) {
      udpSocket.send(msg + '\n', 0, msg.length + 1, port, ip, (err) => {
        if (err) {
          error(
            `aisreporter: send to ${ip}:${port} failed: ${
              (err as Error).message
            }`
          )
        }
      })
    }
  }

  function sendStaticPartZero(
    info: StaticInfo,
    mmsi: string,
    endpoints: Endpoint[]
  ) {
    if (info.name !== undefined) {
      const encoded = new AisEncode({
        aistype: 24, // class B static
        repeat: 0,
        part: 0,
        mmsi: mmsi,
        shipname: info.name
      })
      lastMessages[1] = new Date().toISOString() + ':' + encoded.nmea
      endpoints.forEach((endpoint) => {
        sendReportMsg(encoded.nmea, endpoint.ipaddress, endpoint.port)
      })
    }
  }

  function sendStaticPartOne(
    info: StaticInfo,
    mmsi: string,
    endpoints: Endpoint[]
  ) {
    if (
      info.shipType !== undefined ||
      (info.length !== undefined &&
        info.beam !== undefined &&
        info.fromCenter !== undefined &&
        info.fromBow !== undefined) ||
      info.callsign
    ) {
      const enc_msg: any = {
        aistype: 24, // class B static
        repeat: 0,
        part: 1,
        mmsi: mmsi,
        cargo: info.shipType,
        callsign: info.callsign
      }
      putDimensions(
        enc_msg,
        info.length,
        info.beam,
        info.fromBow,
        info.fromCenter
      )
      const encoded = new AisEncode(enc_msg)
      lastMessages[2] = new Date().toISOString() + ':' + encoded.nmea
      endpoints.forEach((endpoint) => {
        sendReportMsg(encoded.nmea, endpoint.ipaddress, endpoint.port)
      })
    }
  }

  function setKey(info: StaticInfo, dest_key: string, source_key: string) {
    const val = app.getSelfPath(source_key)
    if (val !== undefined) info[dest_key] = val
  }

  function getStaticInfo(): StaticInfo {
    const info: StaticInfo = {}
    setKey(info, 'name', 'name')
    setKey(info, 'length', 'design.length.value.overall')
    setKey(info, 'beam', 'design.beam.value')
    setKey(info, 'callsign', 'communication.callsignVhf')
    setKey(info, 'shipType', 'design.aisShipType.value.id')
    setKey(info, 'fromBow', 'sensors.gps.fromBow.value')
    setKey(info, 'fromCenter', 'sensors.gps.fromCenter.value')
    return info
  }
}

// Merge legacy typo'd keys into the corrected ones. New key always wins
// if both are set; legacy keys are kept on the returned object so a
// failed persistent-migration doesn't break the running start() call.
// When the server exposes app.savePluginOptions we also rewrite the
// on-disk config so the legacy form drops away on next restart.
function migrateLegacyKeys(
  props: Record<string, unknown>,
  app: ServerAPI,
  debug: (msg: string) => void
): Record<string, any> {
  const merged: Record<string, any> = { ...props }
  let migrated = false
  for (const [legacy, corrected] of Object.entries(LEGACY_KEYS)) {
    if (merged[corrected] === undefined && merged[legacy] !== undefined) {
      merged[corrected] = merged[legacy]
      migrated = true
    }
  }
  if (!Array.isArray(merged.endpoints)) {
    merged.endpoints = []
  }
  if (migrated && typeof app.savePluginOptions === 'function') {
    const toPersist = { ...merged }
    for (const legacy of Object.keys(LEGACY_KEYS)) {
      delete toPersist[legacy]
    }
    app.savePluginOptions(toPersist, (err) => {
      if (err) {
        debug(
          `aisreporter: legacy-key migration save failed (ignored): ${err.message}`
        )
      } else {
        debug(
          'aisreporter: migrated legacy config keys (lastpositon* -> lastposition*)'
        )
      }
    })
  }
  return merged
}

interface Endpoint {
  ipaddress: string
  port: number
}

interface StaticInfo {
  name?: string
  length?: number
  beam?: number
  callsign?: string
  shipType?: string
  fromBow?: number
  fromCenter?: number
  [key: string]: unknown
}

function createPositionReportMessage(
  mmsi: string,
  position: Position,
  sog: number | undefined,
  cog: number | undefined,
  head: number | undefined
) {
  return new AisEncode({
    aistype: 18, // class B position report
    repeat: 0,
    mmsi: mmsi,
    sog: sog !== undefined ? mpsToKn(sog) : undefined,
    accuracy: 0, // 0 = regular GPS, 1 = DGPS
    lon: position.longitude,
    lat: position.latitude,
    cog: cog !== undefined ? radsToDeg(cog) : undefined,
    hdg: headingToAisField(head)
  })
}

// Resolve a true heading (radians) for the AIS report:
//   1. navigation.headingTrue when present;
//   2. else derive true from navigation.headingMagnetic + magneticVariation
//      (a compass emitting NMEA HDG rather than HDT leaves Signal K with
//      only a magnetic heading, so without this the plugin would report no
//      heading at all);
//   3. else undefined, signalling "no heading known".
function resolveTrueHeadingRad(app: ServerAPI): number | undefined {
  const headingTrue = app.getSelfPath('navigation.headingTrue.value') as
    | number
    | undefined
  if (typeof headingTrue === 'number' && Number.isFinite(headingTrue)) {
    return headingTrue
  }
  const headingMagnetic = app.getSelfPath(
    'navigation.headingMagnetic.value'
  ) as number | undefined
  const variation = app.getSelfPath('navigation.magneticVariation.value') as
    | number
    | undefined
  if (
    typeof headingMagnetic === 'number' &&
    Number.isFinite(headingMagnetic) &&
    typeof variation === 'number' &&
    Number.isFinite(variation)
  ) {
    // Signal K stores variation east-positive, so true = magnetic + variation.
    return headingMagnetic + variation
  }
  return undefined
}

// Map a true heading (radians) to the AIS heading field: integer degrees
// in [0, 360), or the 511 "not available" sentinel when no heading is
// known. ggencoder truncates the value to an integer degree.
//
// Known limitation: a heading that truncates to exactly 0 (due north) is
// re-substituted with COG inside ggencoder, whose `parseInt(hdg) ||
// parseInt(cog)` treats 0 as falsy. That is a one-degree window we cannot
// close without an upstream fix; everything else encodes faithfully.
function headingToAisField(headingRad: number | undefined): number {
  if (headingRad === undefined) return AIS_HEADING_NOT_AVAILABLE
  // A derived magnetic + variation sum can fall outside one turn; normalize
  // (including negatives) back into [0, 360).
  return ((radsToDeg(headingRad) % 360) + 360) % 360
}

function radsToDeg(radians: number): number {
  return (radians * 180) / Math.PI
}

function mpsToKn(mps: number): number {
  return 1.9438444924574 * mps
}

function putDimensions(
  enc_msg: { dimA?: string; dimB?: string; dimC?: string; dimD?: string },
  length: number | undefined = 0,
  beam: number | undefined = 0,
  fromBow: number | undefined = 0,
  fromCenter: number | undefined = 0
) {
  enc_msg.dimA = fromBow.toFixed(0)
  enc_msg.dimB = (length - fromBow).toFixed(0)
  enc_msg.dimC = (beam / 2 + fromCenter).toFixed(0)
  enc_msg.dimD = (beam / 2 - fromCenter).toFixed(0)
}

export = createPlugin
