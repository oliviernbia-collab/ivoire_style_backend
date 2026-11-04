export class ApiError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

export const badRequest = (msg, errors) => new ApiError(400, msg, errors);
export const unauthorized = (msg = 'Authentification requise') => new ApiError(401, msg);
export const forbidden = (msg = 'Accès refusé') => new ApiError(403, msg);
export const notFound = (msg = 'Ressource introuvable') => new ApiError(404, msg);
export const conflict = (msg) => new ApiError(409, msg);

export function ok(res, data, message, meta) {
  const body = { success: true, data };
  if (message) body.message = message;
  if (meta) body.meta = meta;
  return res.json(body);
}

export function created(res, data, message) {
  return res.status(201).json({ success: true, data, message });
}

export function paginate(query, defaultLimit = 12, maxLimit = 60) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

export function pageMeta(page, limit, total) {
  return { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
}
