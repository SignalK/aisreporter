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

import { combineWith } from 'baconjs'
import { AisEncode } from 'ggencoder'
import * as dgram from 'dgram'

interface Position {
  latitude: number
  longitude: number
}

interface CombinedTuple {
  position: Position | undefined
  sog: number | undefined
  cog: number | undefined
  head: number | undefined
  nmea: string
}

// Some GPS / chartplotter sources emit (0, 0) as a sentinel when they
// have no fix (e.g. while powering down), and Signal K has no explicit
// validity flag. Treat a near-zero pair as "no position" so aggregators
// don't see the vessel parked at Null Island.
function isNullIsland(position: Position | undefined): boolean {
  if (position === undefined) return false
  return (
    Math.abs(position.latitude) < 1e-6 && Math.abs(position.longitude) < 1e-6
  )
}

// Maximum age of the last dynamic (position) reading before static
// reports stop firing. An idle server without a GPS feed must not keep
// pinging aggregators with ghost static data.
const STATIC_MAX_STALE_MS = 10 * 60 * 1000

// Earlier schema versions persisted these typo'd keys, so existing
// users have them baked into their `plugin-config-data/aisreporter.json`.
// We publish the corrected keys, read either spelling (new wins), and —
// on servers that support app.savePluginOptions — rewrite the config
// in-place so persisted settings migrate without user input.
const LEGACY_KEYS: Readonly<Record<string, string>> = {
  lastpositonupdate: 'lastpositionupdate',
  lastpositonupdaterate: 'lastpositionupdaterate'
}

const createPlugin = function (app: any) {
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

  let udpSocket: dgram.Socket
  let unsubscribe: () => void
  let timeout: NodeJS.Timeout | undefined
  const lastMessages: [string, string, string] = ['', '', '']
  let lastMsgNmea: string
  let lastPositionTimeout: NodeJS.Timeout | undefined
  let lastDynamicAt: number | undefined
  let firstDynamicSeen = false

  const plugin: Plugin = {
    start: function (props: any) {
      if (!app.getSelfPath) {
        error(
          'Please upgrade the server, aisreporter needs app.getSelfPath and will not start'
        )
        return
      }
      const mmsi: string = app.getSelfPath('mmsi')

      if (!mmsi) {
        error('aisreporter: mmsi missing in settings')
        return
      }

      const cfg = migrateLegacyKeys(props, app, debug)

      try {
        udpSocket = dgram.createSocket('udp4')
        // `combineWith` type signature changed between baconjs 1.x and 3.x;
        // the cast keeps us compatible across the dual-version matrix (Cerbo
        // Venus OS still ships baconjs 1.x; upstream signalk-server is on 3.x).
        unsubscribe = (combineWith as any)(
          function (
            position: Position | undefined,
            sog: number | undefined,
            cog: number | undefined,
            head: number | undefined
          ): CombinedTuple {
            return {
              position,
              sog,
              cog,
              head,
              nmea: createPositionReportMessage(mmsi, position, sog, cog, head)
                .nmea
            }
          },
          [
            'navigation.position',
            'navigation.speedOverGround',
            'navigation.courseOverGroundTrue',
            'navigation.headingTrue'
          ]
            .map(app.streambundle.getSelfStream, app.streambundle)
            .map((s: any) => s.toProperty(undefined))
        )
          .changes()
          .debounceImmediate((cfg.updaterate || 60) * 1000)
          .onValue((combined: CombinedTuple) => {
            if (
              combined.position === undefined ||
              isNullIsland(combined.position)
            ) {
              return
            }
            lastMessages[0] = new Date().toISOString() + ':' + combined.nmea
            cfg.endpoints.forEach((endpoint: Endpoint) => {
              sendReportMsg(combined.nmea, endpoint.ipaddress, endpoint.port)
            })
            lastMsgNmea = combined.nmea
            lastDynamicAt = Date.now()

            // Announce a fresh vessel to aggregators immediately on its
            // first real dynamic reading; subsequent static reports fall
            // to the interval below.
            if (!firstDynamicSeen) {
              firstDynamicSeen = true
              sendStaticReport()
            }

            if (lastPositionTimeout) {
              clearInterval(lastPositionTimeout)
              lastPositionTimeout = undefined
            }
            if (cfg.lastpositionupdate) {
              lastPositionTimeout = setInterval(
                sendLastPositionReport,
                (cfg.lastpositionupdaterate || 180) * 1000
              )
            }
          })

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

        timeout = setInterval(
          sendStaticReport,
          (cfg.staticupdaterate || 360) * 1000
        )
      } catch (e) {
        plugin.started = false
        console.error(e)
      }
    },

    stop: function () {
      if (unsubscribe) {
        unsubscribe()
      }
      if (timeout) {
        clearInterval(timeout)
        timeout = undefined
      }
      if (lastPositionTimeout) {
        clearInterval(lastPositionTimeout)
        lastPositionTimeout = undefined
      }
      // Without closing the UDP socket, the event loop stays alive after
      // the plugin stops. Matters for tests (mocha won't exit) and for any
      // host that may stop + restart the plugin many times.
      if (udpSocket) {
        udpSocket.close()
      }
      // Reset per-run state so a subsequent start() on the same factory
      // instance starts from a clean slate.
      lastDynamicAt = undefined
      firstDynamicSeen = false
    },

    statusMessage: function () {
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
          error('Failed to send position report.' + err)
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
  app: any,
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
  if (migrated && typeof app.savePluginOptions === 'function') {
    const toPersist = { ...merged }
    for (const legacy of Object.keys(LEGACY_KEYS)) {
      delete toPersist[legacy]
    }
    app.savePluginOptions(toPersist, (err: Error | undefined) => {
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

interface Plugin {
  start: (app: any) => void
  started: boolean
  stop: () => void
  statusMessage: (msg?: string) => string
  id: string
  name: string
  description: string
  schema: any
}

function createPositionReportMessage(
  mmsi: string,
  position: Position | undefined,
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
    lon: position !== undefined ? position.longitude : undefined,
    lat: position !== undefined ? position.latitude : undefined,
    cog: cog !== undefined ? radsToDeg(cog) : undefined,
    hdg: head !== undefined ? radsToDeg(head) : undefined
  })
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
