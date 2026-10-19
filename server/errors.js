/** An error whose message is safe to show to the user, with the HTTP status to answer with. */
export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
