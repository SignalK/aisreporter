import { expect } from 'chai'

// Import through require so the `export =` form of the plugin surfaces
// as a callable value at runtime, matching how signalk-server loads it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const createPlugin = require('../src/index')

describe('aisreporter plugin factory', () => {
  it('exports a factory function', () => {
    expect(createPlugin).to.be.a('function')
  })

  it('factory returns a plugin with the expected surface', () => {
    const plugin = createPlugin({})
    expect(plugin.id).to.equal('aisreporter')
    expect(plugin.name).to.equal('Ais Reporter')
    expect(plugin.start).to.be.a('function')
    expect(plugin.stop).to.be.a('function')
    expect(plugin.statusMessage).to.be.a('function')
    expect(plugin.schema).to.be.an('object')
    expect(plugin.schema.properties).to.have.all.keys(
      'endpoints',
      'updaterate',
      'staticupdaterate',
      'lastpositionupdaterate',
      'lastpositionupdate'
    )
  })

  it('start() without a getSelfPath-capable app is a no-op (does not throw)', () => {
    const errors: string[] = []
    const plugin = createPlugin({
      error: (m: string) => errors.push(m)
    })
    plugin.start({})
    expect(errors[0]).to.include('aisreporter needs app.getSelfPath')
  })

  it('start() without an mmsi is a no-op (does not throw)', () => {
    const errors: string[] = []
    const plugin = createPlugin({
      getSelfPath: () => undefined,
      error: (m: string) => errors.push(m)
    })
    plugin.start({})
    expect(errors[0]).to.include('mmsi missing')
  })
})
