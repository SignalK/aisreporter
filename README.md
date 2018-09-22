# aisreporter
Signal K Node server plugin to report the vessel's AIS data to MarineTraffic and other similar aggregators.

[The static info is retrieved](https://github.com/SignalK/aisreporter/blob/d7e608f7a70bce39e47a00a1df3fc26701f841a0/index.js#L208-L215) from the Signal K full data model. You can use the server's defaults.json mechanism to set the values.

![image](https://user-images.githubusercontent.com/1049678/30029804-6207916a-9193-11e7-99d1-fbca6a9c8627.png)


## Troubleshooting

The source includes a utility `udp_listen` that you can use as a fake receiver to receive what the plugin is actually sending. Configure the plugin to send to for example `localhost` port `12345` and then launch the fake receiver on the machine that your SK server is running on with `./udp_listen 12345`.