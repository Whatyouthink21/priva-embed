/** Wrap async route handlers so express 4 forwards rejections to the error handler. */
export const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
