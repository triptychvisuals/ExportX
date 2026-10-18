'use strict';
// In the repository this re-exports the plugin's client; scripts/package-portal-kit.sh
// replaces it with a copy of src/portal.js so the zipped kit stands on its own.
module.exports = require('../../src/portal');
