// Copyright 2012 Mark Cavage <mcavage@gmail.com> All rights reserved.
//           2013 Bryce B. Baril <bryce@ravenwall.com> All rights reserved.

module.exports = Throttle;

const assert = require("assert-plus");

const TokenBucket = require("./token_bucket");
const TokenTable = require("./token_table");

/**
 * Create a a token-based throttle instance.
 * @param {Object} options Options to create the throttle with.
 *              - {Number} rate The actions per time window to replenish. REQUIRED
 *              - {Number} burst The number allowed to burst to in a time window. Default = rate
 *              - {Number} window The time window in milliseconds to measure actions in. Default = 1000
 *              - {TokensTable} tokensTable A replacement token table to use. Must provide get/set.
 *              - {Object} overrides A set of overrides for certain tokens.
 *                                   Can specify alternate rate, burst, or window.
 *                                   Does not inherit, so defaults apply.
 */
function Throttle(options) {
    if (!(this instanceof Throttle)) return new Throttle(options);
    assert.object(options, "options");
    assert.number(options.rate, "options.rate");

    this.burst = options.burst || options.rate;
    this.rate = options.rate;
    this.window = options.window || 1000;
    const table = options.tokensTable || TokenTable({size: options.maxKeys});
    this.table = table;
    this.overrides = options.overrides;
    this.waiting = false;

    this.getter = table.get;
    this.putter = table.put;
    if (table.put.length === 2 && table.get.length === 1) {
        // This looks like a synchronous table, wrap the methods to make them async.
        this.getter = function (key, cb) {
            process.nextTick(function () {
                cb(null, table.get(key));
            });
        };
        this.putter = function (key, bucket, cb) {
            process.nextTick(function () {
                cb(null, table.put(key, bucket))
            });
        };
    }
    else if (table.put.length !== 3 && table.get.length !== 2) {
        throw new Error("Unable to detect TokenTable implementation type (sync/async) check API.");
    }
}

/**
 * Test a key for throttle status.
 * @param  {String}   key Throttle key to check.
 * @param  {Function} cb  Callback f(err, limited)
 */
Throttle.prototype.rateLimit = function (key, cb) {
    if (key === undefined || key === null) return cb();
    const self = this;

    let burst = self.burst;
    let rate = self.rate;
    let wnd = self.window;

    // Check the overrides
    if (self.overrides &&
        self.overrides[key] &&
        (self.overrides[key].burst !== undefined ||
            self.overrides[key].rate !== undefined ||
            self.overrides[key].window !== undefined)) {

        burst = self.overrides[key].burst;
        rate = self.overrides[key].rate;
        wnd = self.overrides[key].window;
    }

    if (!rate || !burst) return cb();

    if (self.waiting) {
        setTimeout(() => {
            self.rateLimit(key, cb);
        }, 5);
        return;
    }

    self.waiting = true;
    self.getter.call(self.table, key, function (err, bucket) {
        if (err) {
            self.waiting = false;
            return cb(new Error("Unable to check token table" + err));
        }
        if (bucket) {
            // Recreate the token bucket
            bucket = TokenBucket(bucket);
        }
        else {
            // Make a new one
            bucket = TokenBucket({
                capacity: burst,
                fillRate: rate,
                window: wnd,
            });
        }

        const hasCapacity = bucket.consume(1);

        //console.log("Throttle(%s): num_tokens= %d -- throttled: %s", key, bucket.tokens, !hasCapacity)
        self.putter.call(self.table, key, bucket, function (err) {
            self.waiting = false;
            // Error here is not fatal -- we were able to determine throttle status, just not save state.
            if (err) {
                err = new Error("Error saving throttle information to table" + err);
            }
            if (!hasCapacity) {
                return cb(err, true);
            }
            return cb(err, false);
        });
    });
};
