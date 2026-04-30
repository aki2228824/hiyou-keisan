function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'ログインが必要です' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: 'ログインが必要です' });
    if (!roles.includes(req.session.user.role))
      return res.status(403).json({ error: '権限がありません' });
    next();
  };
}

module.exports = { requireAuth, requireRole };
