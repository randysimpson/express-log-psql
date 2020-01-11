/*!
 * express-log-psql
 * Copyright(c) 2010 Sencha Inc.
 * Copyright(c) 2011 TJ Holowaychuk
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2014-2015 Douglas Christopher Wilson
 * Copyright(c) 2020 Randall Simpson
 * MIT Licensed

 * (The MIT License)

 * Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>
 * Copyright (c) 2014-2017 Douglas Christopher Wilson <doug@somethingdoug.com>
 * Copyright (c) 2020 Randall Simpson <chipdawg112@msn.com>

 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * 'Software'), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:

 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.

 * THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

'use strict'

const { Pool } = require('pg');

/**
 * Module exports.
 * @public
 */

module.exports = expressPsql;
module.exports.compile = compile;
module.exports.format = format;
module.exports.token = token;
module.exports.retrieveDB = retrieveDB;

/**
 * Module dependencies.
 * @private
 */

const auth = require('basic-auth');
const debug = require('debug')('expressPsql');
const deprecate = require('depd')('expressPsql');
const onFinished = require('on-finished');
const onHeaders = require('on-headers');

/**
 * Create a logger middleware.
 *
 * @public
 * @param {String|Function} format
 * @param {Object} [options]
 * @return {Function} middleware
 */

function expressPsql(format, options) {
    var fmt = format
    var opts = options || {}

    if (opts.url === undefined ||
        opts.table === undefined) {
        deprecate('expressPsql options must include url and table')
    }

    if (fmt === undefined) {
        fmt = 'default';
    }

    // output on request instead of response
    var immediate = opts.immediate

    // check if log entry should be skipped
    var skip = opts.skip || false

    // format function
    var formatLine = typeof fmt !== 'function'
        ? getFormatFunction(fmt)
        : fmt

    // setup the connection pool
    const pool = new Pool({
      connectionString: opts.url
    });
    expressPsql['pool'] = pool;

    // setup options for retrieve function
    expressPsql['options'] = options;

    //verify that the table has the correct columns.
    verifyTableColumns()
      .then()
      .catch(err => printError(err));

    // stream
    //var stream = opts.stream || process.stdout

    return function logger(req, res, next) {
        // request data
        req._startAt = undefined
        req._startTime = undefined
        req._remoteAddress = getip(req)

        // response data
        res._startAt = undefined
        res._startTime = undefined

        // record request start
        recordStartTime.call(req)

        function logRequest() {
            if (skip !== false && skip(req, res)) {
                debug('skip request')
                return
            }

            var line = formatLine(expressPsql, req, res)

            if (line == null) {
                debug('skip line')
                return
            }

            debug('log request');
            debug(line);

            insertDB(opts.table, line)
                .then()
                .catch((err) => printError(err));
        };

        if (immediate) {
            // immediate log
            logRequest()
        } else {
            // record response start
            onHeaders(res, recordStartTime)

            // log when response finished
            onFinished(res, logRequest)
        }

        next()
    }
}

/**
 * Default format.
 */

expressPsql.format('default', ':date :method :url :status :remote-addr :response-time :http-version :remote-user :res[content-length] :referrer :user-agent')

/**
 * Short format.
 */

expressPsql.format('short', ':remote-addr :remote-user :method :url :http-version :status :res[content-length] :response-time')

/**
 * Tiny format.
 */

expressPsql.format('tiny', ':method :url :status :res[content-length] :response-time')

/**
 * request url
 */

expressPsql.token('url', function getUrlToken(req) {
    return req.originalUrl || req.url
})

/**
 * request method
 */

expressPsql.token('method', function getMethodToken(req) {
    return req.method
})

/**
 * response time in milliseconds
 */

expressPsql.token('response-time', function getResponseTimeToken(req, res, digits) {
    if (!req._startAt || !res._startAt) {
        // missing request and/or response start time
        return
    }

    // calculate diff
    var ms = (res._startAt[0] - req._startAt[0]) * 1e3 +
        (res._startAt[1] - req._startAt[1]) * 1e-6

    // return truncated value
    return parseFloat(ms.toFixed(digits === undefined ? 3 : digits));
})

/**
 * current date
 */

expressPsql.token('date', function getDateToken(req, res, format) {
    var date = new Date()

    return date;
})

/**
 * response status code
 */

expressPsql.token('status', function getStatusToken(req, res) {
    return headersSent(res)
        ? res.statusCode
        : undefined
})

/**
 * normalized referrer
 */

expressPsql.token('referrer', function getReferrerToken(req) {
    return req.headers['referer'] || req.headers['referrer']
})

/**
 * remote address
 */

expressPsql.token('remote-addr', getip)

/**
 * remote user
 */

expressPsql.token('remote-user', function getRemoteUserToken(req) {
    // parse basic credentials
    var credentials = auth(req)

    // return username
    return credentials
        ? credentials.name
        : undefined
})

/**
 * HTTP version
 */

expressPsql.token('http-version', function getHttpVersionToken(req) {
    return parseFloat(req.httpVersionMajor + '.' + req.httpVersionMinor);
})

/**
 * UA string
 */

expressPsql.token('user-agent', function getUserAgentToken(req) {
    return req.headers['user-agent']
})

/**
 * request header
 */

expressPsql.token('req', function getRequestToken(req, res, field) {
    // get header
    var header = req.headers[field.toLowerCase()]

    return Array.isArray(header)
        ? header.join(', ')
        : header
})

/**
 * response header
 */

expressPsql.token('res', function getResponseHeader(req, res, field) {
    if (!headersSent(res)) {
        return undefined
    }

    // get header
    var header = res.getHeader(field)

    return Array.isArray(header)
        ? header.join(', ')
        : header
})

/**
 * Compile a format string into a function.
 *
 * @param {string} format
 * @return {function}
 * @public
 */

function compile(format) {
    if (typeof format !== 'string') {
        throw new TypeError('argument format must be a string')
    }

    let colNames = [];
    var fmt = format.replace(/"/g, '\\"')
    var js = '  "use strict"\n  return {' + fmt.replace(/:([-\w]{2,})(?:\[([^\]]+)\])?/g, function (_, name, arg) {
        var tokenArguments = 'req, res'
        var tokenFunction = 'tokens[' + String(JSON.stringify(name)) + ']'

        if (arg !== undefined) {
            tokenArguments += ', ' + String(JSON.stringify(arg))
        }

        //add the name to the colNames array, sql needs to not have - but _ instead.
        colNames.push(name.replace("-", "_"));

        return '\n    "' + name + '": ' + tokenFunction + '(' + tokenArguments + '),'
    });

    js = js.substring(0, js.length - 1) + '}';

    //save the column names to be used later.
    expressPsql['colNames'] = colNames;

    // eslint-disable-next-line no-new-func
    return new Function('tokens, req, res', js)
}

/**
 * Define a format with the given name.
 *
 * @param {string} name
 * @param {string|function} fmt
 * @public
 */

function format(name, fmt) {
    expressPsql[name] = fmt
    return this
}

/**
 * Lookup and compile a named format function.
 *
 * @param {string} name
 * @return {function}
 * @public
 */

function getFormatFunction(name) {
    // lookup format
    var fmt = expressPsql[name] || name || expressPsql.default

    // return compiled format
    return typeof fmt !== 'function'
        ? compile(fmt)
        : fmt
}

/**
 * Get request IP address.
 *
 * @private
 * @param {IncomingMessage} req
 * @return {string}
 */

function getip(req) {
    return req.ip ||
        req._remoteAddress ||
        (req.connection && req.connection.remoteAddress) ||
        undefined
}

/**
 * Determine if the response headers have been sent.
 *
 * @param {object} res
 * @returns {boolean}
 * @private
 */

function headersSent(res) {
    return typeof res.headersSent !== 'boolean'
        ? Boolean(res._header)
        : res.headersSent
}

/**
 * Record the start time.
 * @private
 */

function recordStartTime() {
    this._startAt = process.hrtime()
    this._startTime = new Date()
}

/**
 * Define a token function with the given name,
 * and callback fn(req, res).
 *
 * @param {string} name
 * @param {function} fn
 * @public
 */

function token(name, fn) {
    expressPsql[name] = fn
    return this
}

/**
 * verify that there is a table and that the table has the correct columns.
 *
 * @return {function} Promise
 * @public
 */

function verifyTableColumns() {
  return new Promise((resolve, reject) => {
    const pool = expressPsql['pool'];
    const columnNames = expressPsql['colNames'];
    const table = expressPsql['options'].table;
    const sql = `select COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_NAME = '${table}';`;
    pool.query(sql, (err, res) => {
      if(err) {
        return reject({
          sql,
          err
        });
      }

      if(res.rows.length === 0) {
        //need to create the table.
        createTable(pool, columnNames)
          .then(() => resolve())
          .catch((err) => reject(err));
      } else {
        //check if the required columns are in the table.
        const missing = columnNames.filter((col) => {
          return res.rows.filter(item => item.column_name === col).length === 0;
        });
        if(missing.length > 0) {
          //adding missing columns.
          addTableColumns(pool, missing)
            .then(() => resolve())
            .catch((err) => reject(err));
          //reject("Table '" + expressPsql['options'].table + "' is missing required columns: " + missing.join(", ") + "\nAdd the columns to the table and restart app.");
        } else {
          resolve();
        }
      }
    });
  });
}

/**
 * Create the table in the db with the correct columns.
 *
 * @param {object} pool
 * @param {array} columns
 * @return {function} Promise
 * @private
 */

function createTable(pool, columns) {
  return new Promise((resolve, reject) => {
    const table = expressPsql['options'].table;
    const columnDef = columns.map(column => column + " " + getColumnType(column)).join(", ");
    const sql = `CREATE TABLE ${table} (${table}_id serial PRIMARY KEY, ${columnDef});`;
    pool.query(sql, (err, res) => {
      if(err) {
        return reject({
          sql,
          err
        });
      }
      resolve();
    });
  });
}

/**
 * function used to get the column type when added columns or creating tables.
 *
 * @param {string} columnName
 * @return {string} type
 * @private
 */

function getColumnType(columnName) {
  let type = 'VARCHAR(50)';
  if(columnName == 'date') {
    type = "TIMESTAMP";
  } else if(columnName == 'status') {
    type = "SMALLINT";
  } else if(["response_time", "http_version"].includes(columnName)) {
    type = "float8";
  } else if(["url", "user_agent"].includes(columnName)) {
    type = "VARCHAR(255)";
  } else if(columnName == 'method') {
    type = "VARCHAR(10)";
  }
  return type;
}

/**
 * function used to add columns to the table.
 *
 * @param {object} pool
 * @param {array} columns
 * @return {function} Promise
 * @private
 */

function addTableColumns(pool, columns) {
  return new Promise((resolve, reject) => {
    const table = expressPsql['options'].table;
    columns.reduce((sequence, columnName) => {
      return sequence.then(() => {
        return addTableColumn(pool, table, columnName, getColumnType(columnName));
      }, (err) => reject(err));
    }, Promise.resolve());

    resolve();
  })
}

/**
 * function used to add a column to the table.
 *
 * @param {object} pool
 * @param {string} table
 * @param {string} columnName
 * @param {string} columnType
 * @return {function} Promise
 * @private
 */

function addTableColumn(pool, table, columnName, columnType) {
  return new Promise((resolve, reject) => {
    const sql = `ALTER TABLE ${table} ADD COLUMN ${columnName} ${columnType};`;
    pool.query(sql, (err, res) => {
      if(err) {
        return reject({
          sql,
          err
        });
      }
      resolve(res);
    });
  });
}


/**
 * function used to insert db array of item
 *
 * @param {string} table
 * @param {object} item
 * @return {function} Promise
 * @private
 */

function insertDB(table, item) {
    return new Promise((resolve, reject) => {
      const pool = expressPsql['pool'];

      //item is object that has all the values to insert into db.
      let colNames = [];
      let values = [];
      for (var key in item) {
        //check for null
        if(item[key]) {
          //sql cannot have - needs to be _
          colNames.push(key.replace("-","_"));
          values.push(item[key]);
        }
      }
      let sqlbuilder = "";
      for(let i = 1; i <= colNames.length; i++) {
        sqlbuilder += "$" + i + ", ";
      }
      sqlbuilder = sqlbuilder.substr(0, sqlbuilder.length - 2);
      const sql = `INSERT INTO ${table} ( ${colNames.join(", ")} ) VALUES ( ${sqlbuilder} );`;
      pool.query(sql, values, (err, res) => {
        if(err) {
          return reject({
            sql,
            err
          });
        }
        resolve(res);
      });
    });
};

/**
 * function used to retrieve the db results
 *
 * @param {string} table
 * @param {object} opts
 * @return {function} Promise
 * @private
 */
function findDB(table, opts) {
    return new Promise((resolve, reject) => {
      const pool = expressPsql['pool'];

      var find = opts.find || [];
      var sort = opts.sort || [];
      var limit = opts.limit || 1000;
      var skip = opts.skip || 0;

      const where = find.length > 0 ? " WHERE " + find.join(" AND ") : "";
      const orderBy = sort.length > 0 ? " ORDER BY " + sort.join(", ") : "";

      const sql = `SELECT * FROM ${table} ${where} ${orderBy} LIMIT ${limit} OFFSET ${skip};`;
      pool.query(sql, (err, res) => {
        if(err) {
          return reject({
            sql,
            err
          });
        }
        resolve(res.rows);
      });
    });
};

/**
 * function that can be used to retrieve the db results
 *
 * @param {object} options
 * @return {function} Promise
 * @public
 */
function retrieveDB(options) {
    var opts = expressPsql['options'];
    return findDB(opts.table, options);
};

/**
 * function used to print an error, could be customized in the future
 *
 * @param {object} err
 * @public
 */
function printError(err) {
  console.error({
    date: new Date(),
    package: "express-log-psql",
    error: err
  });
}
