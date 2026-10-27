// A throwaway second datasource over the same hospital database, so gates that refresh, alter or re-register a source never
// touch the policies and registrations of the real `hospital` datasource.

export const PROBE = 'hospital_probe';

export async function createProbe(ctx) {
  const z = ctx.zt;
  await dropProbe(ctx);
  const user = z.cfg('SAKAIME_HOSPITAL_PG_USER') ?? 'sakaime';
  const create = await ctx.q('admin', `CREATE DATASOURCE ${PROBE} DESCRIBE BY "Throwaway_copy_for_gate_probes" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://hospital-db:5432/hospital", username "${user}", password "${z.cfg('SAKAIME_HOSPITAL_PG_PASSWORD')}")`);
  if (create.outcome !== 'OK') throw new Error(`cannot create the probe datasource: ${create.message}`);
  const register = await ctx.q('admin', `REGISTER DATASOURCE TABLES FROM ${PROBE}`);
  if (register.outcome !== 'OK') throw new Error(`cannot register probe tables: ${register.message}`);
}

export async function dropProbe(ctx) {
  await ctx.q('admin', `DROP DATASOURCE ${PROBE}`);
}

export async function grantProbe(ctx, role) {
  await ctx.q('admin', `ASSIGN DATASOURCE ${PROBE} TO ROLE '${role}'`);
  await ctx.q('admin', `GRANT SELECT ON DATASOURCE NAMESPACE ${PROBE} TO ROLE '${role}'`);
}
