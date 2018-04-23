var operators = require('./operators');
var dataKind = require('./versioned_data_kind');
var util = require('util');
var sha1 = require('node-sha1');
var async = require('async');

var builtins = ['key', 'ip', 'country', 'email', 'firstName', 'lastName', 'avatar', 'name', 'anonymous'];

var noop = function(){};

function evaluate(flag, user, featureStore, cb) {
  cb = cb || noop;
  if (!user || user.key === null || user.key === undefined) {
    cb(null, null, null, null);
    return;
  }

  if (!flag) {
    cb(null, null, null, null);
    return;
  }

  if (!flag.on) {
    // Return the off variation if defined and valid
    cb(null, flag.offVariation, getVariation(flag, flag.offVariation), null);
    return;
  }

  evalInternal(flag, user, featureStore, [], function(err, variation, value, events) {
    if (err) {
      cb(err, variation, value, events);
      return;
    }

    if (variation === null) {
      // Return the off variation if defined and valid
      cb(null, flag.offVariation, getVariation(flag, flag.offVariation), events);
    } else {
      cb(err, variation, value, events);
    }
  });
  return;
}

function evalInternal(flag, user, featureStore, events, cb) {
  // Evaluate prerequisites, if any
  if (flag.prerequisites) {
    async.mapSeries(flag.prerequisites, 
      function(prereq, callback) {
        featureStore.get(dataKind.features, prereq.key, function(f) {
          // If the flag does not exist in the store or is not on, the prerequisite
          // is not satisfied
          if (!f || !f.on) {
            callback(new Error("Unsatisfied prerequisite"), null);
            return;
          }
          evalInternal(f, user, featureStore, events, function(err, variation, value) {
            // If there was an error, the value is null, the variation index is out of range, 
            // or the value does not match the indexed variation the prerequisite is not satisfied
            events.push(createFlagEvent(f.key, f, user, variation, value, null, flag.key));
            if (err || value === null || variation != prereq.variation) {
              callback(new Error("Unsatisfied prerequisite"), null)
            } else { 
              // The prerequisite was satisfied
              callback(null, null);
            }
          });          
        });
      }, 
      function(err, results) {
        // If the error is that prerequisites weren't satisfied, we don't return an error,
        // because we want to serve the 'offVariation'
        if (err) {
          cb(null, null, null, events);
          return;
        } 
        evalRules(flag, user, featureStore, function(e, variation, value) {
          cb(e, variation, value, events);
        });
      })
  } else {
    evalRules(flag, user, featureStore, function(e, variation, value) {
      cb(e, variation, value, events);
    });
  }
}

function evalRules(flag, user, featureStore, cb) {
  var i, j;
  var target;
  var variation;
  var rule;
  // Check target matches
  for (i = 0; i < flag.targets.length; i++) {
    target = flag.targets[i];

    if (!target.values) {
      continue;
    }

    for (j = 0; j < target.values.length; j++) {
      if (user.key === target.values[j]) {
        value = getVariation(flag, target.variation);
        cb(value === null ? new Error("Undefined variation for flag " + flag.key) : null,
          target.variation, value);
        return;
      }
    }
  }

  async.mapSeries(flag.rules,
    function(rule, callback) {
      ruleMatchUser(rule, user, featureStore, function(matched) {
        setImmediate(callback, matched ? rule : null, null);
      });
    },
    function(err, results) {
      // we use the "error" value to indicate that a rule was successfully matched (since we only care
      // about the first match, and mapSeries terminates on the first "error")
      if (err) {
        var rule = err;
        variation = variationForUser(rule, user, flag);
      } else {
        // no rule matched; check the fallthrough
        variation = variationForUser(flag.fallthrough, user, flag);
      }
      cb(variation === null ? new Error("Undefined variation for flag " + flag.key) : null,
          variation, getVariation(flag, variation));
    }
  );
}

function ruleMatchUser(r, user, featureStore, cb) {
  var i;

  if (!r.clauses) {
    return false;
  }

  // A rule matches if all its clauses match
  async.mapSeries(r.clauses,
    function(clause, callback) {
      clauseMatchUser(clause, user, featureStore, function(matched) {
        // on the first clause that does *not* match, we raise an "error" to stop the loop
        setImmediate(callback, matched ? null : clause, null);
      });
    },
    function(err, results) {
      cb(!err);
    }
  );
}

function clauseMatchUser(c, user, featureStore, cb) {
  if (c.op == 'segmentMatch') {
    async.mapSeries(c.values,
      function(value, callback) {
        featureStore.get(dataKind.segments, value, function(segment) {
          if (segment && segmentMatchUser(segment, user)) {
            // on the first segment that matches, we raise an "error" to stop the loop
            callback(segment, null);
          } else {
            callback(null, null);
          }
        });
      },
      function(err, results) {
        // an "error" indicates that a segment *did* match
        cb(maybeNegate(c, !!err));
      }
    );
  } else {
    cb(clauseMatchUserNoSegments(c, user));
  }
}

function clauseMatchUserNoSegments(c, user) {
  var uValue;
  var matchFn;
  var i;

  uValue = userValue(user, c.attribute);

  if (uValue === null || uValue === undefined) {
    return false;
  }

  matchFn = operators.fn(c.op)

  // The user's value is an array
  if (Array === uValue.constructor) {
    for (i = 0; i < uValue.length; i++) {
      if (matchAny(matchFn, uValue[i], c.values)) {
        return maybeNegate(c, true);
      }
    }
    return maybeNegate(c, false);
  }

  return maybeNegate(c, matchAny(matchFn, uValue, c.values));
}

function segmentMatchUser(segment, user) {
  if (user.key) {
    if ((segment.included || []).indexOf(user.key) >= 0) {
      return true;
    }
    if ((segment.excluded || []).indexOf(user.key) >= 0) {
      return false;
    }
    for (var i = 0; i < (segment.rules || []).length; i++) {
      if (segmentRuleMatchUser(segment.rules[i], user, segment.key, segment.salt)) {
        return true;
      }
    }
  }
  return false;
}

function segmentRuleMatchUser(rule, user, segmentKey, salt) {
  for (var i = 0; i < (rule.clauses || []).length; i++) {
    if (!clauseMatchUserNoSegments(rule.clauses[i], user)) {
      return false;
    }
  }

  // If the weight is absent, this rule matches
  if (rule.weight === undefined || rule.weight === null) {
    return true;
  }

  // All of the clauses are met. See if the user buckets in
  var bucket = bucketUser(user, segmentKey, rule.bucketBy || "key", salt);
  var weight = rule.weight / 100000.0;
  return bucket < weight;
}

function maybeNegate(c, b) {
  if (c.negate) {
    return !b;
  } else {
    return b;
  }
}

function matchAny(matchFn, value, values) {
  var i = 0;

  for (i = 0; i < values.length; i++) {
    if (matchFn(value, values[i])) {
      return true;
    }
  }

  return false;
}

// Given an index, return the variation value, or null if 
// the index is invalid
function getVariation(flag, index) {
  if (index === null || index === undefined || index >= flag.variations.length) {
    return null;
  } else {
    return flag.variations[index];
  }
}

// Given a variation or rollout 'r', select
// the variation for the given user
function variationForUser(r, user, flag) {
  var bucketBy;
  var bucket;
  var sum = 0;
  var i;
  var variation;
  if (r.variation != null) {
    // This represets a fixed variation; return it
    return r.variation;
  } else if (r.rollout != null) {
    // This represents a percentage rollout. Assume 
    // we're rolling out by key
    bucketBy = r.rollout.bucketBy != null ? r.rollout.bucketBy : "key";
    bucket = bucketUser(user, flag.key, bucketBy, flag.salt);
    for (i = 0; i < r.rollout.variations.length; i++) {
      variate = r.rollout.variations[i];
      sum += variate.weight / 100000.0;
      if (bucket < sum) {
        return variate.variation;
      }
    }
  }

  return null;
}

// Fetch an attribute value from a user object. Automatically
// navigates into the custom array when necessary
function userValue(user, attr) {
  if (builtins.indexOf(attr) >= 0 && user.hasOwnProperty(attr)) {
    return user[attr];
  } 
  if (user.custom && user.custom.hasOwnProperty(attr)) {
    return user.custom[attr];
  }
  return null;
}

// Compute a percentile for a user
function bucketUser(user, key, attr, salt) {
  var uValue;
  var idHash;

  idHash = bucketableStringValue(userValue(user, attr));

  if (idHash === null) {
    return 0;
  }

  if (user.secondary) {
    idHash += "." + user.secondary;
  }

  hashKey = util.format("%s.%s.%s", key, salt, idHash);
  hashVal = parseInt(sha1(hashKey).substring(0,15), 16);

  result = hashVal / 0xFFFFFFFFFFFFFFF;
  return result;
}

function bucketableStringValue(value) {
  if (typeof(value) === 'string') {
    return value;
  }
  if (Number.isInteger(value)) {
    return '' + value;
  }
  return null;
}

function createFlagEvent(key, flag, user, variation, value, defaultVal, prereqOf) {
  return {
    "kind": "feature",
    "key": key,
    "user": user,
    "variation": variation,
    "value": value,
    "default": defaultVal,
    "creationDate": new Date().getTime(),
    "version": flag ? flag.version : null,
    "prereqOf": prereqOf,
    "trackEvents": flag ? flag.trackEvents : null,
    "debugEventsUntilDate": flag ? flag.debugEventsUntilDate : null
  };
}

module.exports = {evaluate: evaluate, bucketUser: bucketUser, createFlagEvent: createFlagEvent};