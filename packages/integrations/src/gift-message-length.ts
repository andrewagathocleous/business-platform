/**
 * The card limit. Import, print and the gift-card renderer share this function.
 * It lives in `@bp/domain` so documents and integrations can both use it.
 */
export { GIFT_MESSAGE_MAX_CODE_POINTS, giftMessageTooLong } from '@bp/domain';
