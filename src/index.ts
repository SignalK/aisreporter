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
import { isUndefined } from 'util'
import { AisEncode, AisEncodeOptions } from 'ggencoder'
import * as dgram from 'dgram'
const _ = require('lodash')
const util = require('util')

export default function (app: any) {
  const error = app.error || ((msg: string) => { console.error(msg) })
  const debug = app.debug || ((msg: string) => { console.log(msg) })

  let udpSocket: dgram.Socket
  let unsubscribe: () => void
  let timeout: any
  let lastMessages: [string, string, string] = ['', '', '']

  const plugin: Plugin = {

    start: function (props: any) {
      if (!app.getSelfPath) {
        error("Please upgrade the server, aisreporter needs app.getSelfPath and will not start")
        return
      }
      const mmsi: string = app.getSelfPath('mmsi')


      if (!mmsi) {
        error('aisreporter: mmsi missing in settings')
        return
      }

      try {
        udpSocket = dgram.createSocket('udp4')
        unsubscribe = combineWith<any, any>(function (position: Position, sog: number, cog: number, head: number) {
          return createPositionReportMessage(mmsi, position, sog, cog, head)
        }, [
          'navigation.position',
          'navigation.speedOverGround',
          'navigation.courseOverGroundTrue',
          'navigation.headingTrue'
        ]
          .map(app.streambundle.getSelfStream, app.streambundle)
          .map((s: any) => s.toProperty(undefined)))
          .changes()
          .debounceImmediate((props.updaterate || 60) * 1000)
          .onValue((msg: any) => {
            lastMessages[0] = new Date().toISOString() + ':' + msg.nmea
            props.endpoints.forEach((endpoint: Endpoint) => {
              sendReportMsg(msg.nmea, endpoint.ipaddress, endpoint.port)
            })
          })

        var sendStaticReport = function () {
          var info = getStaticInfo()
          if (Object.keys(info).length) {
            sendStaticPartZero(info, mmsi, props.endpoints)
            sendStaticPartOne(info, mmsi, props.endpoints)
          }
        }

        sendStaticReport()
        timeout = setInterval(
          sendStaticReport,
          (props.staticupdaterate || 360) * 1000
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
        }
      }
    }
  }

  return plugin

  function sendReportMsg(msg: string, ip: string, port: number) {
    debug(ip + ':' + port + ' ' + msg)
    if (udpSocket) {
      udpSocket.send(msg + '\n', 0, msg.length + 1, port, ip, err => {
        if (err) {
          error('Failed to send position report.', err)
        }
      })
    }
  }

  function sendStaticPartZero(info: StaticInfo, mmsi: string, endpoints: Endpoint[]) {
    if (info.name !== undefined) {
      var encoded = new AisEncode({
        aistype: 24, // class B static
        repeat: 0,
        part: 0,
        mmsi: mmsi,
        shipname: info.name
      })
      lastMessages[1] = new Date().toISOString() + ':' + encoded.nmea
      endpoints.forEach(endpoint => {
        sendReportMsg(encoded.nmea, endpoint.ipaddress, endpoint.port)
      })
    }
  }

  function sendStaticPartOne(info: StaticInfo, mmsi: string, endpoints: Endpoint[]) {
    if (
      info.shipType !== undefined ||
      (info.length !== undefined &&
        info.beam !== undefined &&
        info.fromCenter !== undefined &&
        info.fromBow !== undefined) ||
      info.callsign
    ) {
      var enc_msg = {
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
      var encoded = new AisEncode(enc_msg)
      lastMessages[2] = new Date().toISOString() + ':' + encoded.nmea
      endpoints.forEach(endpoint => {
        sendReportMsg(encoded.nmea, endpoint.ipaddress, endpoint.port)
      })
    }
  }

  function setKey(info: StaticInfo, dest_key: string, source_key: string) {
    const val = app.getSelfPath(source_key)
    if (!isUndefined(val)) info[dest_key] = val
  }

  function getStaticInfo(): StaticInfo {
    var info: StaticInfo = {}
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

interface Endpoint {
  ipaddress: string,
  port: number
}

interface StaticInfo {
  name?: string,
  length?: number,
  beam?: number,
  callsign?: string,
  shipType?: string,
  fromBow?: number,
  fromCenter?: number,
  [key: string]: any
}

interface Plugin {
  start: (app: any) => void,
  started: boolean,
  stop: () => void,
  statusMessage: (msg: string) => void,
  id: string,
  name: string,
  description: string,
  schema: any
}

function createPositionReportMessage(mmsi: string, position: any, sog: number, cog: number, head: number) {
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
  return radians * 180 / Math.PI
}

function mpsToKn(mps: number): number {
  return 1.9438444924574 * mps
}

function putDimensions(enc_msg: any, length: number | undefined = 0, beam: number | undefined = 0, fromBow: number | undefined = 0, fromCenter: number | undefined = 0) {
  enc_msg.dimA = fromBow.toFixed(0)
  enc_msg.dimB = (length - fromBow).toFixed(0)
  enc_msg.dimC = (beam / 2 + fromCenter).toFixed(0)
  enc_msg.dimD = (beam / 2 - fromCenter).toFixed(0)
}

