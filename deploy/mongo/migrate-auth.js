// For a data volume created before authentication: creates the root user through the localhost
// exception, then the application user. Run once after switching to the authenticated compose:
//   docker compose exec -T mongo mongosh --quiet --file /conclavix/migrate-auth.js
while (!db.hello().isWritablePrimary) sleep(500);
const admin = db.getSiblingDB('admin');
admin.createUser({
  user: process.env.MONGO_INITDB_ROOT_USERNAME,
  pwd: process.env.MONGO_INITDB_ROOT_PASSWORD,
  roles: ['root'],
});
admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD);
load('/docker-entrypoint-initdb.d/create-app-user.js');
print('created root and application user');
