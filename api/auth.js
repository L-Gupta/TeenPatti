'use strict';
module.exports = (req, res) => require('../lib/router').handle('auth', req, res);
