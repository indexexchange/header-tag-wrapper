'use strict';

var Browser = require('browser.js');
var CommandQueue = require('command-queue.js');
var Prms = require('prms.js');
var SpaceCamp = require('space-camp.js');
var System = require('system.js');
var Utilities = require('utilities.js');

//? if (DEBUG) {
var Inspector = require('schema-inspector.js');
var ConfigValidators = require('config-validators.js');
var Scribe = require('scribe.js');
var Whoopsie = require('whoopsie.js');
//? }

var TimerService;

function ComplianceService(configs) {
    var __CMP_CHECK_INTERVAL = 250;

    var __gdprApplies;

    var __gdprConsentString;

    var __cmd;

    var __status;

    var __EnumStatuses = {
        NOT_STARTED: 0,
        IN_PROGRESS: 1,
        COMPLETE: 2
    };

    var __complianceTimeout;

    var __retrievalDefer;

    var __complianceTimerId;

    var __customCmpFunction;

    var __cmpHasReturnedData;

    var __postMessageId = 0;

    function __interpretCmpResultObject(result) {
        if (result.hasOwnProperty('gdprApplies')
            && Utilities.getType(result.gdprApplies) === 'boolean') {
            __gdprApplies = result.gdprApplies;
        } else if (result.hasOwnProperty('isUserInEu')
            && Utilities.getType(result.isUserInEu) === 'boolean') {
            __gdprApplies = result.isUserInEu;
        }

        if (result.hasOwnProperty('consentData')
            && Utilities.getType(result.consentData) === 'string') {
            __gdprConsentString = result.consentData;
        }
    }

    function __cmpCallback(result) {
        if (__cmpHasReturnedData) {
            return;
        }

        var type = Utilities.getType(result);

        if (type === 'undefined') {
            return;
        }

        __cmpHasReturnedData = true;

        //? if (DEBUG) {
        Scribe.info('CMP callback received result: ' + JSON.stringify(result));
        //? }

        if (type === 'string') {
            //? if (DEBUG) {
            Scribe.info('CMP result interpreted as string');
            //? }
            __gdprConsentString = result;
        } else if (type === 'object') {
            //? if (DEBUG) {
            Scribe.info('CMP result interpreted as object');
            //? }
            __interpretCmpResultObject(result);
        } else {
            //? if (DEBUG) {
            Scribe.warn('CMP result had unexpected type: ' + type);
            //? }
        }

        __retrievalDefer.resolve();
    }

    function __makeCmpCaller(inWindow, custom) {
        return function () {
            if (inWindow) {
                try {
                    window.__cmp('getConsentData', null, __cmpCallback);
                } catch (ex) {
                    //? if (DEBUG) {
                    Scribe.error('CMP function error:');
                    Scribe.error(ex);
                    //? }
                }
            }

            if (custom) {
                try {
                    __customCmpFunction(__cmpCallback);
                } catch (ex) {
                    //? if (DEBUG) {
                    Scribe.error('Custom CMP function error:');
                    Scribe.error(ex);
                    //? }
                }
            }
        };
    }

    function __messageListener(ev) {
        try {
            var dataObj;

            if (Utilities.getType(ev.data) === 'string') {
                dataObj = JSON.parse(ev.data);
            } else {
                dataObj = ev.data;
            }

            if (!dataObj.hasOwnProperty('__cmpReturn') || Utilities.getType(dataObj.__cmpReturn) !== 'object') {
                return;
            }

            var retVal = dataObj.__cmpReturn;
            if (retVal.callId === __postMessageId) {
                __cmpCallback(retVal.returnValue, retVal.success);
                window.removeEventListener('message', __messageListener, false);
            }
        } catch (ex) {
            //? if (DEBUG) {
            Scribe.error('Error occurred while handling CMP inter-frame message: ', ex.stack);
            //? }
        }
    }

    function setGdprApplies(applies) {
        //? if (DEBUG){
        var results = Inspector.validate({
            type: 'boolean'
        }, applies);

        if (!results.valid) {
            throw Whoopsie('INVALID_ARGUMENT', results.format());
        }

        Scribe.info('Setting GDPR applicability bit to: ' + applies);
        //? }

        __gdprApplies = applies;
    }

    function getGdprConsent() {
        return {
            applies: __gdprApplies,
            consentString: __gdprConsentString
        };
    }

    function isPrivacyEnabled() {
        return true;
    }

    function delay(func) {
        return function () {
            if (__status !== __EnumStatuses.COMPLETE && __complianceTimerId) {
                TimerService.startTimer(__complianceTimerId);
            }

            var args = arguments;

            __cmd.push(function () {
                func.apply(null, args);
            });
        };
    }

    function __retrieve() {
        if (__status !== __EnumStatuses.NOT_STARTED) {
            return;
        }

        __retrievalDefer = Prms.defer();

        __status = __EnumStatuses.IN_PROGRESS;

        __retrievalDefer.promise.then(function () {
            __cmd = CommandQueue(__cmd);
            __status = __EnumStatuses.COMPLETE;
        });

        var calledCmpSomehow = false;
        var inWindow = false;
        var custom = false;

        if (window.__cmp && Utilities.getType(window.__cmp) === 'function') {
            //? if (DEBUG) {
            Scribe.info('Found CMP in window.__cmp');
            //? }
            inWindow = true;
        }

        if (__customCmpFunction) {
            //? if (DEBUG) {
            Scribe.info('Found CMP in __customCmpFunction');
            //? }
            custom = true;
        }

        if (inWindow || custom) {
            calledCmpSomehow = true;

            var callCmpOnce = __makeCmpCaller(inWindow, custom);
            callCmpOnce();

            if (__complianceTimeout > 0) {
                var cmpCallIntervalId = window.setInterval(callCmpOnce, __CMP_CHECK_INTERVAL);

                __retrievalDefer.promise.then(function () {
                    window.clearInterval(cmpCallIntervalId);
                });
            }
        } else {
            //? if (DEBUG) {
            Scribe.info('Looking for CMP ancestor frame.');
            //? }

            var cmpFrame = Browser.traverseContextTree(function (context) {
                if (context.__cmpLocator) {
                    return context;
                }

                return null;
            });

            if (cmpFrame) {
                calledCmpSomehow = true;

                __postMessageId = System.generateUniqueId();

                var message = {
                    __cmpCall: {
                        command: 'getConsentData',
                        parameter: null,
                        callId: __postMessageId
                    }
                };

                window.addEventListener('message', __messageListener, false);

                cmpFrame.postMessage(JSON.stringify(message), '*');
                cmpFrame.postMessage(message, '*');
            }
        }

        if (!calledCmpSomehow) {
            __retrievalDefer.resolve();

            return;
        }

        if (__complianceTimeout === 0) {
            __retrievalDefer.resolve();
        } else if (!__complianceTimerId) {
            __complianceTimerId = TimerService.createTimer(__complianceTimeout, false, function () {
                //? if (DEBUG) {
                if (__status !== __EnumStatuses.COMPLETE) {
                    Scribe.info('CMP timed out with no result, using default (no consent)');
                }
                //? }
                __retrievalDefer.resolve();
            });
        }
    }

    function wait() {
        if (__status === __EnumStatuses.NOT_STARTED) {
            __retrieve();
        }

        if (__status !== __EnumStatuses.COMPLETE && __complianceTimerId) {
            TimerService.startTimer(__complianceTimerId);
        }

        return __retrievalDefer.promise;
    }

    (function __constructor() {
        TimerService = SpaceCamp.services.TimerService;

        //? if (DEBUG){
        var results = ConfigValidators.ComplianceService(configs);

        if (results) {
            throw Whoopsie('INVALID_CONFIG', results);
        }
        //? }

        __gdprApplies = configs.gdprAppliesDefault;
        __gdprConsentString = '';
        __cmd = [];
        __complianceTimeout = configs.timeout;
        __status = __EnumStatuses.NOT_STARTED;
        __cmpHasReturnedData = false;

        if (configs.customFn) {
            try {
                __customCmpFunction = eval(configs.customFn);
                if (Utilities.getType(__customCmpFunction) !== 'function') {
                    //? if (DEBUG) {
                    Scribe.error('Error: custom CMP function must have type function and doesn\'t');
                    //? }
                    __customCmpFunction = null;
                }
            } catch (ex) {
                //? if (DEBUG) {
                Scribe.error('Error evaluating custom CMP function:');
                Scribe.error(ex);
                //? }
                __customCmpFunction = null;
            }
        } else {
            __customCmpFunction = null;
        }

        __retrieve();
    })();

    return {

        //? if (DEBUG) {
        __type__: 'ComplianceService',
        //? }

        gdpr: {

            getConsent: getGdprConsent,
            setApplies: setGdprApplies
        },

        isPrivacyEnabled: isPrivacyEnabled,
        delay: delay,
        wait: wait,

        //? if (TEST) {
        __gdprApplies: __gdprApplies,
        __gdprConsentString: __gdprConsentString,
        __retrieve: __retrieve,
        __interpretCmpResultObject: __interpretCmpResultObject,
        __cmpCallback: __cmpCallback,
        __makeCmpCaller: __makeCmpCaller,
        __messageListener: __messageListener
        //? }
    };
}

module.exports = ComplianceService;