'use strict';

const Resource = require('resourcejs');
const async = require('async');
const {VM} = require('vm2');
const _ = require('lodash');
const debug = {
  error: require('debug')('formio:error'),
  action: require('debug')('formio:action')
};
const util = require('../util/util');
const moment = require('moment');
const promisify = require('util').promisify;
const {
  ConditionOperators,
  filterComponentsForConditionComponentFieldOptions,
  conditionOperatorsByComponentType,
  allConditionOperatorsOptions,
  getValueComponentsForEachFormComponent,
  getValueComponentRequiredSettings,
} = require('../util/conditionOperators');

/**
 * The ActionIndex export.
 *
 * @param router
 *
 * @returns {{actions: {}, register: Function, search: Function, execute: Function}}
 */
module.exports = (router) => {
  const hook = require('../util/hook')(router.formio);

  /**
   * Create the ActionIndex object.
   *
   * @type {{actions: {}, register: Function, search: Function, execute: Function}}
   */
  const ActionIndex = {

    /**
     * A list of all the actions.
     */
    actions: hook.alter('actions', {
      email: require('./EmailAction')(router),
      login: require('./LoginAction')(router),
      resetpass: require('./ResetPassword')(router),
      role: require('./RoleAction')(router),
      save: require('./SaveSubmission')(router),
      webhook: require('./WebhookAction')(router),
    }),

    /**
     * The model to use for each Action.
     */
    model: router.formio.mongoose.model('action'),

    /**
     * Load all actions for a provided form.
     *
     * @param req
     * @param next
     * @returns {*}
     */
    loadActions(req, res, next) {
      if (!req.actions) {
        req.actions = {};
      }

      const form = req.formId;
      if (!form) {
        return next();
      }

      // Use cache if it is available.
      if (req.actions && req.actions[form]) {
        return next(null, req.actions[form]);
      }

      // Find the actions associated with this form.
      this.model.find(hook.alter('actionsQuery', {
        form,
        deleted: {$eq: null},
      }, req))
      .sort('-priority')
      .lean()
      .exec((err, result) => {
        if (err) {
          return next(err);
        }

        // Iterate through all of the actions and load them.
        const actions = [];
        _.each(result, (action) => {
          if (!this.actions.hasOwnProperty(action.name)) {
            return;
          }

          // Create the action class.
          const ActionClass = this.actions[action.name];
          actions.push(new ActionClass(action, req, res));
        });

        req.actions[form] = actions;
        return next(null, actions);
      });
    },

    /**
     * Find an action within the available actions for this form.
     *
     * @param handler
     * @param method
     * @param req
     * @param next
     */
    search(handler, method, req, res, next) {
      if (!req.formId) {
        return next(null, []);
      }

      // Make sure we have actions attached to the request.
      if (req.actions) {
        const actions = (req.actions[req.formId] || []).filter((action) =>
          (!handler || action.handler.includes(handler)) &&
          (!method || action.method.includes(method)));
        return next(null, actions);
      }
      else {
        // Load the actions.
        this.loadActions(req, res, (err) => {
          if (err) {
            return next(err);
          }

          this.search(handler, method, req, res, next);
        });
      }
    },

    /**
     * Load an initialize all actions for this form.
     *
     * @param req
     * @param res
     * @param next
     */
    initialize(method, req, res, next) {
      this.search(null, method, req, res, (err, actions) => {
        if (err) {
          return next(err);
        }

        // Iterate through each action.
        async.forEachOf(actions, (action, index, done) => {
          if (actions[index].initialize) {
            actions[index].initialize(method, req, res, done);
          }
          else {
            done();
          }
        }, next);
      });
    },

    /**
     * Execute an action provided a handler, form, and request params.
     *
     * @param handler
     * @param method
     * @param req
     * @param res
     * @param next
     */
    execute(handler, method, req, res, next) {
      // Find the available actions.
      this.search(handler, method, req, res, (err, actions) => {
        if (err) {
          router.formio.log(
            'Actions search fail',
            req,
            handler,
            method,
            err
          );
          return next(err);
        }

        async.eachSeries(actions, (action, cb) => {
          this.shouldExecute(action, req).then(execute => {
            if (!execute) {
              return cb();
            }
            // Resolve the action.
            router.formio.log('Action', req, handler, method, action.name, action.title);

            const logAction = hook.alter('logAction', req, res, action, handler, method, () => cb);
            // if logs are allowed, the logging logic resolves the action. If logs are not allowed, the action is to be resolved here.
            if (!logAction) {
              action.resolve(handler, method, req, res, (err) => {
                if (err) {
                  return cb(err);
                }
                return cb();
              }, () => {});
            }
          });
        }, (err) => {
          if (err) {
            router.formio.log('Actions execution fail', req, handler, method, err);
            return next(err);
          }

          next();
        });
      });
    },

    async shouldExecute(action, req) {
      const condition = action.condition;
      if (!condition) {
        return true;
      }

      if (condition.custom) {
        let json = null;
        try {
          json = JSON.parse(action.condition.custom);
        }
        catch (e) {
          json = null;
        }

        try {
          const isDelete = req.method.toUpperCase() === 'DELETE';
          const deletedSubmission = isDelete ? await getDeletedSubmission(req): false;
          const params = await hook.alter('actionContext', {
            jsonLogic: util.FormioUtils.jsonLogic,
            data: isDelete ? _.get(deletedSubmission, `data`, {}) : req.body.data,
            form: req.form,
            query: req.query,
            util: util.FormioUtils,
            moment: moment,
            submission: isDelete ? deletedSubmission : req.body,
            previous: req.previousSubmission,
            execute: false,
            _
          }, req);

          let vm = new VM({
            timeout: 500,
            sandbox: {
              execute: params.execute,
              query: params.query,
              data: params.data,
              form: params.form,
              submission: params.submission,
              previous: params.previous,
            },
            eval: false,
            fixAsync: true
          });

          vm.freeze(params.jsonLogic, 'jsonLogic');
          vm.freeze(params.FormioUtils, 'util');
          vm.freeze(params.moment, 'moment');
          vm.freeze(params._, '_');

          const result = vm.run(json ?
            `execute = jsonLogic.apply(${condition.custom}, { data, form, _, util })` :
            condition.custom
          );

          vm = null;

          return result;
        }
        catch (err) {
          router.formio.log(
            'Error during executing action custom logic',
            req,
            err
          );
          debug.error(err);
          return false;
        }
      }

      // Check if the action has a condition saved using the old format
      if (!_.isEmpty(condition.field) && !_.isEmpty(condition.eq)) {
        // See if a condition is not established within the action.
        const field = condition.field || '';
        const eq = condition.eq || '';
        const value = String(await getComponentValueFromRequest(req, field));
        const compare = String(condition.value || '');
        debug.action(
          '\nfield', field,
          '\neq', eq,
          '\nvalue', value,
          '\ncompare', compare
        );

        // Cancel the action if the field and eq aren't set, in addition to the value not being the same as compare.
        return (eq === 'equals') ===
          ((Array.isArray(value) && value.map(String).includes(compare)) || (value === compare));
      }
      else if (_.some(condition.conditions || [], condition => condition.component && condition.operator)) {
        const {conditions = [], conjunction = 'all'} = condition;

        // Check all the conditions and save results to array
        const conditionsResults = await Promise.all(conditions.map(async (cond) => {
          const {value: comparedValue, operator, component: conditionComponentPath} = cond;
          const ConditionOperator = ConditionOperators[operator];
          if (!conditionComponentPath || !ConditionOperator) {
            return true;
          }
          const value = await getComponentValueFromRequest(req, conditionComponentPath);
          let component;
          if (req.currentFormComponents) {
            component = util.FormioUtils.getComponent(req.currentFormComponents, conditionComponentPath);
          }
          return new ConditionOperator().getResult({value, comparedValue, component});
        }));

        return conjunction === 'any' ?
            _.some(conditionsResults, res => !!res) :
            _.every(conditionsResults, res => !!res);
      }

      // If there are no conditions either in the old nor in the new format, allow executing an action
      return true;
    },
  };

  /**
   * Get the settings form for each action.
   *
   * @param action
   */
  function getSettingsForm(action, req, cb) {
    const mainSettings = {
      components: []
    };
    const conditionalSettings = {
      components: []
    };

    // If the defaults are read only.
    if (action.access && (action.access.handler === false)) {
      mainSettings.components.push({
        type: 'hidden',
        input: true,
        key: 'handler'
      });
    }
    else {
      mainSettings.components.push({
        type: 'select',
        input: true,
        key: 'handler',
        label: 'Handler',
        placeholder: 'Select which handler(s) you would like to trigger',
        dataSrc: 'json',
        data: {json: JSON.stringify([
          {
            name: 'before',
            title: 'Before'
          },
          {
            name: 'after',
            title: 'After'
          }
        ])},
        template: '<span>{{ item.title }}</span>',
        valueProperty: 'name',
        multiple: true
      });
    }

    if (action.access && (action.access.method === false)) {
      mainSettings.components.push({
        type: 'hidden',
        input: true,
        key: 'method'
      });
    }
    else {
      mainSettings.components.push({
        type: 'select',
        input: true,
        label: 'Methods',
        key: 'method',
        placeholder: 'Trigger action on method(s)',
        dataSrc: 'json',
        data: {json: JSON.stringify([
          {
            name: 'create',
            title: 'Create'
          },
          {
            name: 'update',
            title: 'Update'
          },
          {
            name: 'read',
            title: 'Read'
          },
          {
            name: 'delete',
            title: 'Delete'
          },
          {
            name: 'index',
            title: 'Index'
          }
        ])},
        template: '<span>{{ item.title }}</span>',
        valueProperty: 'name',
        multiple: true
      });
    }

    router.formio.cache.loadForm(req, undefined, req.params.formId, (err, form) => {
      if (err || !form || !form.components) {
        return cb('Could not load form components for conditional actions.');
      }

      const flattenedComponents = router.formio.util.flattenComponents(form.components);

      const componentsOptionsForExtendedUi = filterComponentsForConditionComponentFieldOptions(flattenedComponents);
      const flattenedComponentsForConditional = _.pick(
          flattenedComponents,
          componentsOptionsForExtendedUi.map(({value}) => value)
      );
      const valueComponentsByComponentPath = getValueComponentsForEachFormComponent(flattenedComponentsForConditional);
      const valueComponent = getValueComponentRequiredSettings(valueComponentsByComponentPath);

      const customPlaceholder = `
        // Example: Only execute if submitted roles has 'authenticated'.
        JavaScript: execute = (data.roles.indexOf('authenticated') !== -1);
        JSON: { "in": [ "authenticated", { "var": "data.roles" } ] }
      `;
      conditionalSettings.components.push({
        type: 'container',
        key: 'condition',
        input: false,
        tree: true,
        components: [
          {
            key: 'columns',
            type: 'columns',
            input: false,
            columns: [
              {
                components: [
                  {
                    label: 'When',
                    widget: 'choicesjs',
                    tableView: true,
                    data: {
                      values: [
                        {
                          label: 'When all conditions are met',
                          value: 'all',
                        },
                        {
                          label: 'When any condition is met',
                          value: 'any',
                        },
                      ],
                    },
                    key: 'conjunction',
                    type: 'select',
                    input: true,
                  },
                  {
                    label: 'Conditions',
                    addAnotherPosition: 'bottom',
                    key: 'conditions',
                    type: 'editgrid',
                    initEmpty: true,
                    addAnother: 'Add Condition',
                    templates: {
                      header:`<div class="row">\n      {% util.eachComponent(components, function(component) { %}\n        {% if (displayValue(component)) { %}\n          <div class="col-sm-{{_.includes(['component'], component.key) ? '4' : '3'}}">{{ t(component.label) }}</div>\n        {% } %}\n      {% }) %}\n    </div>`,
                      row: `<div class="row">\n      {% util.eachComponent(components, function(component) { %}\n        {% if (displayValue(component)) { %}\n          <div class="formio-builder-condition-text col-sm-{{_.includes(['component'], component.key) ? '4' : '3'}}">\n            {{ isVisibleInRow(component) ? getView(component, row[component.key]) : ''}}\n          </div>\n        {% } %}\n      {% }) %}\n      {% if (!instance.options.readOnly && !instance.disabled) { %}\n        <div class="col-sm-2">\n          <div class="btn-group pull-right">\n            <button class="btn btn-default btn-light btn-sm editRow"><i class="{{ iconClass('edit') }}"></i></button>\n            {% if (!instance.hasRemoveButtons || instance.hasRemoveButtons()) { %}\n              <button class="btn btn-danger btn-sm removeRow"><i class="{{ iconClass('trash') }}"></i></button>\n            {% } %}\n          </div>\n        </div>\n      {% } %}\n    </div>`,
                    },
                    input: true,
                    components: [
                      {
                        label: 'When:',
                        widget: 'choicesjs',
                        tableView: true,
                        dataSrc: 'json',
                        valueProperty: 'value',
                        placeholder: 'Select Form Component',
                        lazyLoad: false,
                        data: {json: JSON.stringify(componentsOptionsForExtendedUi)},
                        key: 'component',
                        type: 'select',
                        input: true,
                      },
                      {
                        label: 'Is:',
                        widget: 'choicesjs',
                        tableView: true,
                        dataSrc: 'custom',
                        lazyLoad: false,
                        placeholder: 'Select Comparison Operator',
                        refreshOn: 'condition.conditions.component',
                        clearOnRefresh: true,
                        valueProperty: 'value',
                        data: {
                          custom:`
                            const formComponents = ${JSON.stringify(flattenedComponents)};
                            const conditionComponent = formComponents[row.component];
                            const componentType = conditionComponent ? conditionComponent.type : 'base';
                            const operatorsByComponentType = ${JSON.stringify(conditionOperatorsByComponentType)};
                            let operators = operatorsByComponentType[componentType];
                            if (!operators || !operators.length) {
                              operators = operatorsByComponentType.base;
                            }
                            const allOperators = ${JSON.stringify(allConditionOperatorsOptions)};

                            values = allOperators.filter((operator) => operators.includes(operator.value));
                          `
                        },
                        key: 'operator',
                        type: 'select',
                        input: true,
                      },
                      {
                        type: 'textfield',
                        inputFormat: 'plain',
                        ...valueComponent,
                      },
                    ],
                  },
                ]
              },
              {
                components: [
                  {
                    key: 'well2',
                    type: 'well',
                    input: false,
                    components: [
                      {
                        key: 'html',
                        type: 'htmlelement',
                        tag: 'h4',
                        input: false,
                        content: 'Or you can provide your own custom JavaScript or <a href="http://jsonlogic.com" target="_blank">JSON</a> condition logic here',
                        className: ''
                      },
                      {
                        label: '',
                        type: 'textarea',
                        input: true,
                        key: 'custom',
                        editorComponents: form.components,
                        placeholder: customPlaceholder
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      });

      // Create the settings form.
      const actionSettings = {
        type: 'fieldset',
        input: false,
        tree: true,
        legend: 'Action Settings',
        components: []
      };

      // The default settings form.
      const settingsForm = {
        components: [
          {type: 'hidden', input: true, key: 'priority'},
          {type: 'hidden', input: true, key: 'name'},
          {
            type: 'textfield',
            input: true,
            label: 'Title',
            key: 'title'
          },
          actionSettings,
          {
            type: 'fieldset',
            input: false,
            tree: false,
            key: 'conditions',
            legend: 'Action Execution',
            components: mainSettings.components
          },
          {
            key: 'fieldset',
            type: 'fieldset',
            input: false,
            tree: false,
            legend: 'Action Conditions (optional)',
            components: conditionalSettings.components
          },
          {
            key: 'html2',
            type: 'htmlelement',
            tag: 'hr',
            input: false,
            content: '',
            className: ''
          },
          {
            type: 'button',
            input: true,
            label: 'Save Action',
            key: 'submit',
            size: 'md',
            leftIcon: '',
            rightIcon: '',
            block: false,
            action: 'submit',
            disableOnInvalid: true,
            theme: 'primary'
          }
        ]
      };

      // Return the settings form.
      return cb(null, {
        actionSettings: actionSettings,
        settingsForm: settingsForm
      });
    });
  }

  async function getDeletedSubmission(req) {
    try {
      return await promisify(router.formio.cache.loadSubmission)(
        req,
        req.body.form,
        req.body._id,
      );
    }
    catch (err) {
      router.formio.log(
        'Error during executing action custom logic',
        req,
        err
      );
      debug.error(err);
      return false;
    }
  }

  async function getComponentValueFromRequest(req, field) {
    const isDelete = req.method.toUpperCase() === 'DELETE';
    const deletedSubmission = isDelete ? await getDeletedSubmission(req): false;
    const value = isDelete? _.get(deletedSubmission, `data.${field}`, '') :
      _.get(req, `body.data.${field}`, '');
    return value;
  }

  // Return a list of available actions.
  router.get('/form/:formId/actions', (req, res, next) => {
    const result = [];

    // Add an action to the results array.
    function addAction(action) {
      action.defaults = action.defaults || {};
      action.defaults = _.assign(action.defaults, {
        priority: action.priority || 0,
        name: action.name,
        title: action.title
      });

      hook.alter('actionInfo', action, req);
      result.push(action);
    }

    // Iterate through each of the available actions.
    async.eachSeries(_.values(ActionIndex.actions), (action, callback) => {
      action.info(req, res, (err, info) => {
        if (err) {
          router.formio.log('Error, can\'t get action info', req, err);
          return callback(err);
        }
        if (!info || (info.name === 'default')) {
          return callback();
        }

        addAction(info);
        callback();
      });
    }, (err) => {
      if (err) {
        router.formio.log('Error during actions info parsing', req, err);
        return next(err);
      }

      res.json(result);
    });
  });

  // Return a list of available actions.
  router.get('/form/:formId/actions/:name', (req, res, next) => {
    const action = ActionIndex.actions[req.params.name];
    if (!action) {
      return res.status(400).send('Action not found');
    }

    action.info(req, res, (err, info) => {
      if (err) {
        router.formio.log('Error, can\'t get action info', req, err);
        return next(err);
      }

      info.defaults = info.defaults || {};
      info.defaults = _.assign(info.defaults, {
        priority: info.priority || 0,
        name: info.name,
        title: info.title
      });

      try {
        getSettingsForm(action, req, (err, settings) => {
          if (err) {
            router.formio.log('Error, can\'t get action settings', req, err);
            return res.status(400).send(err);
          }

          action.settingsForm(req, res, (err, settingsForm) => {
            if (err) {
              router.formio.log('Error, can\'t get form settings', req, err);
              return next(err);
            }

            // Add the ability to change the title, and add the other settings.
            settings.actionSettings.components = [{
              input: false,
              type: 'container',
              key: 'settings',
              components: settingsForm
            }];

            info.settingsForm = settings.settingsForm;
            info.settingsForm.action = hook.alter('path', `/form/${req.params.formId}/action`, req);
            hook.alter('actionInfo', info, req);
            res.json(info);
          });
        });
      }
      catch (e) {
        debug.error(e);
        return res.sendStatus(400);
      }
    });
  });

  // Before all middleware for actions.
  function actionPayload(req, res, next) {
    if (req.body) {
      // Translate the request body if data is provided.
      if (req.body.hasOwnProperty('data')) {
        req.body = req.body.data;
      }

      // Set the form on the request body.
      req.body.form = req.params.formId;

      // Make sure to store handler to lowercase.
      if (req.body.handler) {
        _.each(req.body.handler, (handler, index) => {
          req.body.handler[index] = handler.toLowerCase();
        });
      }

      // Make sure the method is uppercase.
      if (req.body.method) {
        _.each(req.body.method, (method, index) => {
          req.body.method[index] = method.toLowerCase();
        });
      }
    }

    req.modelQuery = req.modelQuery || req.model || this.model;
    req.countQuery = req.countQuery || req.model || this.model;
    req.modelQuery = req.modelQuery.find({form: req.params.formId}).sort('-priority');
    req.countQuery = req.countQuery.find({form: req.params.formId});
    next();
  }

  // After Index middleware for actions.
  function indexPayload(req, res, next) {
    res.resource.status = 200;
    _.each(res.resource.item, (item) => {
      if (ActionIndex.actions.hasOwnProperty(item.name)) {
        item = _.assign(item, ActionIndex.actions[item.name].info);
      }
    });

    next();
  }

  // Build the middleware stack.
  const handlers = {};
  const methods = ['Post', 'Get', 'Put', 'Index', 'Delete'];
  methods.forEach((method) => {
    handlers[`before${method}`] = [
      (req, res, next) => {
        if (req.method === 'GET') {
          // Perform an extra permission check for action GET requests.
          req.method = 'PUT';
          req.permissionsChecked = false;
          router.formio.middleware.permissionHandler(req, res, () => {
            req.method = 'GET';
            next();
          });
        }
        else {
          return next();
        }
      },
      router.formio.middleware.filterMongooseExists({field: 'deleted', isNull: true}),
      actionPayload
    ];
    handlers[`after${method}`] = [
      router.formio.middleware.filterResourcejsResponse(['deleted', '__v', 'externalTokens'])
    ];
  });
  handlers['beforePatch'] = (req, res, next) => {
    // Disable Patch for actions for now.
    if (req.method === 'PATCH') {
      return res.sendStatus(405);
    }
    return next();
  };

  // Add specific middleware to individual endpoints.
  handlers['beforeDelete'] = handlers['beforeDelete'].concat([router.formio.middleware.deleteActionHandler]);
  handlers['afterIndex'] = handlers['afterIndex'].concat([indexPayload]);
  handlers['afterGet'] = handlers['afterGet'].concat([
    (req, res, next) => {
      if (req.params && req.params.actionId && res.resource && res.resource.item) {
        const action = res.resource.item;
        if (action.condition && !_.isEmpty(action.condition.field) && !_.isEmpty(action.condition.eq)) {
          action.condition = {
            conjunction: 'all',
            conditions: [{
              component: action.condition.field,
              operator: action.condition.eq === 'equals' ? 'isEqual' : 'isNotEqual',
              value: action.condition.value,
            }]
          };
        }
      }
      return next();
    }
  ]);

  /**
   * Create the REST properties using ResourceJS, as a nested resource of forms.
   *
   * Adds the endpoints:
   * [GET]    /form/:formId/action
   * [GET]    /form/:formId/action/:actionId
   * [PUT]    /form/:formId/action/:actionId
   * [POST]   /form/:formId/action/:actionId
   * [DELETE] /form/:formId/action/:actionId
   *
   * @TODO: Add `action` validation on POST/PUT with the keys inside `available`.
   */
  Resource(router, '/form/:formId', 'action', ActionIndex.model).rest(hook.alter('actionRoutes', handlers));

  // Return the action index.
  return ActionIndex;
};
