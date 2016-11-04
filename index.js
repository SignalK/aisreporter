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

const debug = require('debug')('marinetrafficreporter')

const Bacon = require('baconjs');

const AisEncode = require("ggencoder").AisEncode
const dgram = require('dgram')

module.exports = function(app) {
  var udpSocket
  var plugin = {}
  var unsubscribe = undefined

  plugin.start = function(props) {
    debug("starting with " + props.ipaddress + ":" + props.port)
    var mmsi = app.config.settings.vessel.mmsi

    try {
      udpSocket = require('dgram').createSocket('udp4')
      unsubscribe = Bacon.combineWith(function(position, sog, cog) {
        return createPositionReportMessage(mmsi, position.latitude, position.longitude, mpsToKn(sog), cog)
      }, ['navigation.position', 'navigation.speedOverGround', 'navigation.courseOverGroundTrue'].map(app.streambundle.getOwnStream, app.streambundle)).changes().debounceImmediate(60000).onValue(msg => {
        sendPositionReportMsg(msg, props.ipaddress, props.port)
      })
    } catch (e) {
      plugin.started = false
      console.log(e)
    }
    debug("started")
  };

  plugin.stop = function() {
    debug("stopping")
    if (unsubscribe) {
      unsubscribe()
    }
    debug("stopped")
  };

  plugin.id = "marinetrafficreporter"
  plugin.name = "Marine Traffic Reporter"
  plugin.description = "Plugin that reports self's position periodically to Marine Traffic via UDP ASI messages"

  plugin.schema = {
    type: "object",
    required: [
      "ipaddress", "port"
    ],
    properties: {
      ipaddress: {
        type: "string",
        title: "UDP endpoint IP address",
        default: "0.0.0.0"
      },
      port: {
        type: "number",
        title: "Port",
        default: "12345"
      }
    }
  }

  return plugin;

  function sendPositionReportMsg(msg, ip, port) {
    debug(ip + ':' + port + ' ' + JSON.stringify(msg.nmea))
    if (udpSocket) {
      udpSocket.send(msg.nmea, 0, msg.nmea.length, port, ip, err => {
        if (err) {
          console.log('Failed to send position report.', err)
        }
      })
    }
  }
}


function createPositionReportMessage(mmsi, lat, lon, sog, cog) {
  return new AisEncode({
    aistype: 18, // class B position report
    repeat: 0,
    mmsi: mmsi,
    sog: sog,
    accuracy: 0, // 0 = regular GPS, 1 = DGPS
    lon: lon,
    lat: lat,
    cog: cog
  })
}

function radsToDeg(radians) {
  return radians * 180 / Math.PI
}

function mpsToKn(mps) {
  return 1.9438444924574 * mps
}
