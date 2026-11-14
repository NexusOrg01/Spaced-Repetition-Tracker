(function () {
  'use strict';

  const nativeBridge = window.NexusAndroidBridge;
  if (nativeBridge && nativeBridge.isNativeApp) return;

  const config = window.NexusBuildConfig && window.NexusBuildConfig.posthog;
  if (!config || typeof config.key !== 'string' || !config.key.trim() || !config.host) return;

  let host;
  try {
    const parsed = new URL(config.host);
    const allowedHosts = new Set(['us.i.posthog.com', 'eu.i.posthog.com']);
    if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname) ||
        parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) return;
    host = parsed.origin;
  } catch (_) {
    return;
  }

  // Official PostHog browser loader. It queues calls until the asynchronous SDK loads.
  !function (t, e) {
    var o, n, p, r;
    e.__SV || (window.posthog && window.posthog.__loaded) ||
      (window.posthog = e, e._i = [], e.init = function (i, s, a) {
        function g(t, e) {
          var o = e.split('.');
          2 == o.length && (t = t[o[0]], e = o[1]);
          t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); };
        }
        p || ((p = t.createElement('script')).type = 'text/javascript', p.crossOrigin = 'anonymous',
          p.async = !0, p.src = s.api_host.replace('.i.posthog.com', '-assets.i.posthog.com') + '/static/array.js',
          p.onerror = function () { p = null; },
          (r = t.getElementsByTagName('script')[0]).parentNode.insertBefore(p, r));
        var u = e;
        for (void 0 !== a ? u = e[a] = [] : a = 'posthog',
          u.people = u.people || [],
          Object.defineProperty(u, 'toString', { configurable: !0, enumerable: !0, writable: !0,
            value: function (t) { var e = 'posthog'; return 'posthog' !== a && (e += '.' + a), t || (e += ' (stub)'), e; } }),
          Object.defineProperty(u.people, 'toString', { configurable: !0, enumerable: !0, writable: !0,
            value: function () { return u.toString(1) + ' (stub)'; } }),
          o = 'init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug'.split(' '),
          n = 0; n < o.length; n++) g(u, o[n]);
        e._i.push([i, s, a]);
      }, e.__SV = 1);
  }(document, window.posthog || []);

  function safeUrl(value) {
    try {
      const parsed = new URL(String(value), window.location && window.location.origin);
      return parsed.origin + parsed.pathname;
    } catch (_) {
      return null;
    }
  }

  function safeException(item) {
    if (!item || typeof item !== 'object') return item;
    const clean = { ...item };
    if (Object.prototype.hasOwnProperty.call(clean, 'value')) clean.value = 'Nexus exception';
    if (clean.stacktrace && Array.isArray(clean.stacktrace.frames)) {
      clean.stacktrace = {
        ...clean.stacktrace,
        frames: clean.stacktrace.frames.map(frame => {
          if (!frame || typeof frame !== 'object') return frame;
          const safeFrame = { ...frame };
          for (const field of ['filename', 'abs_path', 'url']) {
            if (safeFrame[field]) safeFrame[field] = safeUrl(safeFrame[field]);
          }
          return safeFrame;
        })
      };
    }
    return clean;
  }

  function sanitizeEvent(event) {
    if (!event || !event.properties || typeof event.properties !== 'object') return event;
    const properties = event.properties;
    for (const key of Object.keys(properties)) {
      if (['$current_url', '$referrer', '$initial_referrer'].includes(key)) {
        properties[key] = safeUrl(properties[key]);
      } else if (key === '$exception_message') {
        properties[key] = 'Nexus exception';
      } else if (key === '$exception_list' && Array.isArray(properties[key])) {
        properties[key] = properties[key].map(safeException);
      } else if (/(email|password|token|study|note|topic|subject|workspace|user_id)/i.test(key)) {
        delete properties[key];
      }
    }
    return event;
  }

  window.posthog.init(config.key, {
    api_host: host,
    defaults: '2026-08-30',
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    persistence: 'memory',
    person_profiles: 'identified_only',
    disable_session_recording: true,
    disable_surveys: true,
    before_send: sanitizeEvent
  });

  const allowedAreas = new Set([
    'module-load', 'workspace-render', 'consistency-render',
    'cloud-initialize', 'cloud-upload', 'cloud-connect', 'auth-google', 'auth-email'
  ]);

  window.NexusAnalytics = Object.freeze({
    captureHandledError(error, area) {
      if (!window.posthog || typeof window.posthog.captureException !== 'function') return;
      const safeError = new Error('Handled Nexus error');
      safeError.name = 'NexusHandledError';
      const lines = error && typeof error.stack === 'string' ? error.stack.split('\n') : [];
      if (lines.length > 1) {
        const safeFrames = lines.slice(1).map(line => line.replace(/[?#][^\s)]*/g, ''));
        safeError.stack = 'NexusHandledError: Handled Nexus error\n' + safeFrames.join('\n');
      }
      window.posthog.captureException(safeError, {
        nexus_area: allowedAreas.has(area) ? area : 'other'
      });
    }
  });
})();
