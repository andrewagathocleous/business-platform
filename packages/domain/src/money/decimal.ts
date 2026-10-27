import Decimal from 'decimal.js';

// One configuration for every money calculation. Half-up is away from zero at exactly .5.
Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

export default Decimal;
