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

const Bacon = require('baconjs')
const AisEncode = require('ggencoder').AisEncode
const dgram = require('dgram')
const _ = require('lodash')
const util = require('util')

module.exports = function (app) {
  const error = app.error || (msg => {console.error(msg)})
  const debug = app.debug || (msg => {console.log(msg)})

  var udpSocket
  var plugin = {}
  var unsubscribe
  var timeout

  plugin.start = function (props) {
    if (!app.getSelfPath) {
      error("Please upgrade the server, aisreporter needs app.getSelfPath and will not start")
      return
    }
    var mmsi = app.getSelfPath('mmsi')


    if (!mmsi) {
      error('aisreporter: mmsi missing in settings')
      return
    }

    try {
      udpSocket = require('dgram').createSocket('udp4')
      unsubscribe = Bacon.combineWith(function (position, sog, cog, head) {
        return createPositionReportMessage(mmsi, position, sog, cog, head)
      }, [
        'navigation.position',
        'navigation.speedOverGround',
        'navigation.courseOverGroundTrue',
        'navigation.headingTrue'
      ]
        .map(app.streambundle.getSelfStream, app.streambundle)
        .map(s => s.toProperty(undefined)))
        .changes()
        .debounceImmediate((props.updaterate || 60) * 1000)
        .onValue(msg => {
          props.endpoints.forEach(endpoint => {
            sendReportMsg(msg, endpoint.ipaddress, endpoint.port)
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
      console.log(e)
    }
  }

  plugin.stop = function () {
    if (unsubscribe) {
      unsubscribe()
    }
    if (timeout) {
      clearInterval(timeout)
      timeout = undefined
    }
  }

  plugin.id = 'aisreporter'
  plugin.name = 'Ais Reporter'
  plugin.description =
    "Plugin that reports self's position periodically to Marine Traffic and/or AISHub via UDP AIS messages"

  plugin.schema = {
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

  return plugin

  function sendReportMsg (msg, ip, port) {
    debug(ip + ':' + port + ' ' + JSON.stringify(msg.nmea))
    if (udpSocket) {
      udpSocket.send(msg.nmea + '\n', 0, msg.nmea.length + 1, port, ip, err => {
        if (err) {
          error('Failed to send position report.', err)
        }
      })
    }
  }

  function sendStaticPartZero (info, mmsi, endpoints) {
    if (info.name !== undefined) {
      var encoded = new AisEncode({
        aistype: 24, // class B static
        repeat: 0,
        part: 0,
        mmsi: mmsi,
        shipname: info.name
      })
      endpoints.forEach(endpoint => {
        sendReportMsg(encoded, endpoint.ipaddress, endpoint.port)
      })
    }
  }

  function sendStaticPartOne (info, mmsi, endpoints) {
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
      endpoints.forEach(endpoint => {
        sendReportMsg(encoded, endpoint.ipaddress, endpoint.port)
      })
    }
  }

  function setKey (info, dest_key, source_key) {
    var val = _.get(app.signalk.self, source_key)
    if (val !== undefined) info[dest_key] = val
  }

  function getStaticInfo () {
    var info = {}
    info.name = app.config.settings.vessel.name
    setKey(info, 'length', 'design.length.overall')
    setKey(info, 'beam', 'design.beam.value')
    setKey(info, 'callsign', 'communication.callsignVhf')
    setKey(info, 'shipType', 'design.aisShipType')
    setKey(info, 'fromBow', 'sensors.gps.fromBow.value')
    setKey(info, 'fromCenter', 'sensors.gps.fromCenter.value')
    return info
  }
}

function createPositionReportMessage (mmsi, position, sog, cog, head) {
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

function radsToDeg (radians) {
  return radians * 180 / Math.PI
}

function mpsToKn (mps) {
  return 1.9438444924574 * mps
}

function putDimensions (enc_msg, length, beam, fromBow, fromCenter) {
  enc_msg.dimA = fromBow.toFixed(0)
  enc_msg.dimB = (length - fromBow).toFixed(0)
  enc_msg.dimC = (beam / 2 + fromCenter).toFixed(0)
  enc_msg.dimD = (beam / 2 - fromCenter).toFixed(0)
}
