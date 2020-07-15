'use strict';

const _ = require('lodash');
const debug = require('debug')('formio:middleware:submissionResourceAccessFilter');
const EVERYONE = '000000000000000000000000';

module.exports = function(router) {
  return function submissionResourceAccessFilter(req, res, next) {
    const util = router.formio.util;

    // Skip this filter, if request is from an administrator.
    if (req.isAdmin) {
      debug('Skipping, request is from an administrator.');
      return next();
    }

    // Skip this filter, if not flagged in the permission handler.
    if (!_.has(req, 'submissionFieldMatchAccessFilter') || req.submissionFieldMatchAccessFilter === false) {
      return next();
    }

    // Should never get here WITHOUT a form id present or WITH a submission id present.
    if (!req.formId || req.subId) {
      return res.sendStatus(400);
    }

    const userId = _.get(req, 'user._id');
    const userRoles = _.get(req, 'user.roles', []);
    userRoles.push(EVERYONE);
    // Perform our search.
    let query = null;
    const hasRolesIntersection = (condition) => !!_.intersectionWith(condition.roles, userRoles,
      (role, userRole) => role.toString() === userRole.toString()).length;

    // Map permissions to array of Mongo conditions
    const fieldsToCheck = Object.entries(req.submissionFieldMatchAccess).flatMap(([, conditions]) => {
      return conditions.map((condition) => {
        if (hasRolesIntersection(condition)) {
          const {formFieldPath, operator, valueOrPath, valueType}= condition;
          const value = valueType === 'userFieldPath' ? _.get(req, `user.${valueOrPath}`) : valueOrPath;

          if (value) {
            return {[`data.${formFieldPath}`]:  {[operator]: value}};
          }
        }
      });
    }).filter((condition) => !!condition);

    if (userId) {
      fieldsToCheck.push({owner: util.idToBson(userId)});
    }

    query = fieldsToCheck.length !== 0 ? {
      form: util.idToBson(req.formId),
      deleted: {$eq: null},
      $or: [...fieldsToCheck]
    } : {
      form: util.idToBson(req.formId),
      deleted: {$eq: null},
    };

    req.modelQuery = req.modelQuery || req.model || this.model;
    req.modelQuery = req.modelQuery.find(query);

    req.countQuery = req.countQuery || req.model || this.model;
    req.countQuery = req.countQuery.find(query);

    next();
  };
};