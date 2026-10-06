// Healthy once this member is PRIMARY; initiates the single-member replica set on first start.
db.getSiblingDB('admin').auth(
  process.env.MONGO_INITDB_ROOT_USERNAME,
  process.env.MONGO_INITDB_ROOT_PASSWORD,
);
let state;
try {
  state = rs.status().myState;
} catch (error) {
  if (error.codeName !== 'NotYetInitialized') throw error;
  rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongo:27017' }] });
}
if (state !== 1) quit(1);
