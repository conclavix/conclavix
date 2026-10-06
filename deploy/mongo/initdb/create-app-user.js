// Runs once on an empty data volume. The application user may only read and write the conclavix
// database, which covers its transactions, index builds and change streams.
db.getSiblingDB('conclavix').createUser({
  user: process.env.MONGO_APP_USERNAME || 'conclavix',
  pwd: process.env.MONGO_APP_PASSWORD,
  roles: [{ role: 'readWrite', db: 'conclavix' }],
});
