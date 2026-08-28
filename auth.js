'use strict';

const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { upsertUser, getUserById } = require('./db');

const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'alunopueri.com.br').toLowerCase();

function isAllowedEmail(email) {
  return typeof email === 'string' && email.toLowerCase().endsWith('@' + ALLOWED_DOMAIN);
}

// Sem hd de propósito: com hd, o Google rejeita a requisição (invalid_request)
// se a conta logada no aparelho não for do domínio. A trava de domínio é
// feita de verdade aqui no servidor (isAllowedEmail abaixo), então o hd
// só atrapalhava a UX. Se quiser reativar: acrescente hostedDomain aqui.
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: `${process.env.BASE_URL || 'http://localhost:3000'}/auth/google/callback`,
}, (accessToken, refreshToken, profile, done) => {
  // Trava dupla: o domínio tem que bater, senão nem grava o usuário.
  const email = profile.emails?.[0]?.value;
  const hd = profile._json?.hd;

  if (!isAllowedEmail(email)) {
    return done(null, false, { message: 'domínio-não-permitido' });
  }
  // Se o Google informou hosted domain (hd), tem que ser o nosso também.
  if (hd && hd.toLowerCase() !== ALLOWED_DOMAIN) {
    return done(null, false, { message: 'domínio-não-permitido' });
  }

  let user;
  try {
    // ⚠️ O Passport usa `profile.id` (não `googleId`) — normalizamos aqui.
    user = upsertUser({
      googleId: profile.id,
      displayName: profile.displayName,
      emails: profile.emails,
      photos: profile.photos,
    });
  } catch (err) {
    return done(err);
  }
  return done(null, user);
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const user = getUserById(id);
  done(null, user || null);
});

module.exports = { passport, isAllowedEmail };
