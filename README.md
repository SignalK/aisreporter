# aisreporter
Signal K Node server plugin to report the vessel's AIS data to MarineTraffic, AISHub and other similar aggregators.

This plugin generates raw NMEA messages using vessel's position, speed, heading, etc. It does not require an AIS receiver or transceiver. If you do have an AIS, it also doesn't send positions received from it. If you would like a plugin that relays AIS data, check [`ais-forwarder`](https://github.com/hkapanen/ais-forwarder) instead.

The static info used in `aisreporter` is retrieved from the [Signal K data for specific paths](https://github.com/SignalK/aisreporter/blob/a14562cd3f3f535f040368f59307bfa6c116ddb1/src/index.ts#L210-L216). The most important values like the MMSI number and the vessel name are available in the server's setting via the UI, for the rest you can use the server's defaults.json mechanism.

![image](https://user-images.githubusercontent.com/1049678/30029804-6207916a-9193-11e7-99d1-fbca6a9c8627.png)

## Creating Stations
In order to use this plugin, you will need an IP address and a UDP port number, which requires you to create a station with MarineTraffic, AISHub or another aggregator. In order to create a station, visit [My Stations page on MarineTraffic](https://www.marinetraffic.com/en/users/my_account/stations/index) or [Join Us page on AISHub](https://www.aishub.net/join-us).

## Troubleshooting

The source includes a utility `udp_listen` that you can use as a fake receiver to receive what the plugin is actually sending. Configure the plugin to send to for example `localhost` port `12345` and then launch the fake receiver on the machine that your SK server is running on with `./udp_listen 12345`.
