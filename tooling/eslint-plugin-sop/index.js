import noRawDesignValues from './rules/no-raw-design-values.js';

// Local plugin, registered in eslint.config.mjs as `sop`.
export default {
  meta: { name: 'eslint-plugin-sop', namespace: 'sop' },
  rules: {
    'no-raw-design-values': noRawDesignValues,
  },
};
