import { badRequest } from '../utils/http.js';

/** Valide req[source] avec un schéma zod et remplace par la valeur nettoyée dans req.valid. */
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source] ?? {});
  if (!result.success) {
    const errors = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!errors[key]) errors[key] = issue.message;
    }
    throw badRequest('Certains champs sont invalides', errors);
  }
  req.valid = result.data;
  next();
};
