/**
 * electron-builder config. Installers are published to GitHub Releases of
 * this repo; installed copies poll those releases for updates.
 */
module.exports = {
  appId: 'com.mattyjamesclark.cadcam',
  productName: 'CADCAM Studio',
  directories: { buildResources: 'build', output: 'dist' },
  files: ['out/**/*', 'package.json'],
  win: { icon: 'build/icon.ico', target: [{ target: 'nsis', arch: ['x64'] }], artifactName: 'CADCAM-Studio-Setup-${version}.${ext}' },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    deleteAppDataOnUninstall: false
  },
  publish: {
    provider: 'github',
    owner: process.env.RELEASE_OWNER || 'MattyJamesClark',
    repo: process.env.RELEASE_REPO || 'cadcam',
    releaseType: 'draft'
  }
}
