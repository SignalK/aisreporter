declare module 'ggencoder' {
  export interface AisEncodeOptions {
    mmsi: string,
    aistype?: number,
    repeat?: number,
    part?: number,
    sog?: number | undefined,
    accuracy?: number,
    lon?: number | undefined,
    lat?: number | undefined,
    cog?: number | undefined,
    hdg?: number | undefined,
    cargo?: string | undefined
    shipname?: string | undefined
  }

  export class AisEncode {
    constructor(options: AisEncodeOptions)
    nmea: string
  }
}