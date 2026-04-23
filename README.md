# aisreporter

[![CI](https://github.com/SignalK/aisreporter/actions/workflows/ci.yml/badge.svg)](https://github.com/SignalK/aisreporter/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@signalk/aisreporter.svg)](https://www.npmjs.com/package/@signalk/aisreporter)
[![License](https://img.shields.io/npm/l/@signalk/aisreporter.svg)](https://github.com/SignalK/aisreporter/blob/master/LICENSE)

Signal K server plugin that reports the vessel's position, speed,
heading, and static info to
[MarineTraffic](https://www.marinetraffic.com/),
[AISHub](https://www.aishub.net/), and similar aggregators over UDP.

The plugin generates the raw NMEA AIS messages itself (class B
position-report type 18 + static-data type 24) from Signal K paths. It
does **not** require a real AIS receiver or transceiver, and it
**will not** forward positions that came in from your existing AIS. If
you have an AIS and want to relay its frames, use
[`ais-forwarder`](https://github.com/hkapanen/ais-forwarder) instead.

## Installation

Through the Signal K server admin UI — App Store → search for
_aisreporter_ → install. Or from the command line in your `~/.signalk`
dir:

```sh
npm install @signalk/aisreporter
```

Requires [signalk-server](https://github.com/SignalK/signalk-server)
with Node `>=22`.

## Usage

1. Configure vessel MMSI and name in the server admin UI
   (_Server → Settings → Vessel_). Static AIS fields — length, beam,
   callsign, ship type, GPS offset from bow / centre — come from
   [`design.*`](https://signalk.org/specification/1.7.0/doc/vesselsBranch.html#designvessel-design-parameters)
   Signal K paths, usually populated via `defaults.json`.
2. Enable the plugin in _Server → Plugin Config → Ais Reporter_ and
   add one or more UDP endpoints (see
   [Creating stations](#creating-stations) for where to get them).
3. Save. The plugin sends position reports at the configured rate and
   static reports on a slower rate.

![Plugin configuration page](https://user-images.githubusercontent.com/1049678/121819974-c9f05c00-cc98-11eb-943e-814889a81947.png)

### Options

| Key                     | Default | Meaning                                                                                                |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `endpoints`             | `[]`    | List of `{ipaddress, port}` UDP destinations.                                                          |
| `updaterate`            | `60` s  | Position report interval (debounced).                                                                  |
| `staticupdaterate`      | `360` s | Static info (name, dimensions, callsign) report interval.                                              |
| `lastpositonupdate`     | `false` | Keep resending the last known position while position data isn't changing (e.g. GPS off while docked). |
| `lastpositonupdaterate` | `180` s | Interval of the last-known-position resend.                                                            |

The static info written into AIS messages is read from these Signal K
paths, in addition to the vessel MMSI and name:

- `design.length.value.overall`
- `design.beam.value`
- `design.aisShipType.value.id`
- `communication.callsignVhf`
- `sensors.gps.fromBow.value`
- `sensors.gps.fromCenter.value`

## Creating stations

You need an IP address and a UDP port assigned by an aggregator before
the plugin can do anything useful. Request one from:

- [MarineTraffic — My Stations](https://www.marinetraffic.com/en/users/my_account/stations/index)
- [AISHub — Join Us](https://www.aishub.net/join-us)

Other receivers that accept plain UDP AIS frames (e.g. a local
OpenCPN) also work.

## Troubleshooting

The repo ships a `udp_listen` shell helper that acts as a fake
receiver. Configure the plugin to send to `localhost:12345`, then run:

```sh
./udp_listen 12345
```

on the same machine to see exactly what the plugin is emitting.

## Contributing

Issues and pull requests welcome at
[SignalK/aisreporter](https://github.com/SignalK/aisreporter).
`npm test` runs the mocha suite; `npm run typecheck` +
`npm run build` guard the TypeScript surface; `npm run mutation` runs
Stryker.

## License

ISC. See [LICENSE](LICENSE).
