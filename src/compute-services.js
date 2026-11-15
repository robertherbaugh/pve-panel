import { haPolicy } from './compute-ha-policy.js';
import { db, audit } from './db.js';
import { computeProfile, computeCatalog, saveComputeProfile } from './compute-catalog.js';
import { requireCustomer } from './tenancy.js';
import { capacityBusy } from './capacity.js';
const fail=(message,statusCode=409)=>{throw Object.assign(new Error(message),{statusCode});};
export function customerServices(customer) {
  const p=computeProfile(customer.id);
  return {revision:p.revision,enabled:p.catalogEnabled,canManage:customer.role==='admin',tier:p.tier,
    backupServiceEnabled:p.backupServiceEnabled,backupServiceIncluded:p.backupServiceIncluded,backupStorageIncluded:false,backupClassId:'basic',backupLimitGb:p.backupLimitGb};
}
export default async function computeServiceRoutes(app) {
  app.addHook('preHandler',app.authenticate);
  app.get('/api/compute-ha-policy',async req=>{const p=haPolicy(),c=computeProfile(requireCustomer(req).id);return {enabled:p.enabled&&c.haAllowed,revision:p.revision,slaVersion:p.slaVersion,msaVersion:p.msaVersion,terms:p.terms};});
  app.get('/api/compute-services',async req=>customerServices(requireCustomer(req)));
  app.put('/api/compute-services',{schema:{body:{type:'object',additionalProperties:false,required:['revision','backupServiceEnabled'],properties:{revision:{type:'integer',minimum:0},backupServiceEnabled:{type:'boolean'}}}}},async req=>{
    const customer=requireCustomer(req),p=computeProfile(customer.id);
    if(customer.role!=='admin') fail('Only customer administrators can change add-ons',403);
    if(!p.catalogEnabled) fail('Catalog services are not enabled for this customer',403);
    if(capacityBusy(customer.id)) fail('Wait until the current compute operation finishes');
    if(p.revision!==req.body.revision) fail('Customer services changed. Reload before saving.');
    // Only this selection can change. Provider quotas, sizes and HA eligibility stay protected.
    const {catalogEnabled,network,revision,tier,sizeIds,storageClassIds,haAllowed,storageLimitsGb,backupLimitGb}=p;
    saveComputeProfile(customer.id,{catalogEnabled,network,revision,catalogRevision:computeCatalog().revision,tier,sizeIds,storageClassIds,haAllowed,storageLimitsGb,backupLimitGb,backupServiceEnabled:req.body.backupServiceEnabled});
    if(!req.body.backupServiceEnabled) db.prepare('DELETE FROM backup_schedules WHERE customer_id=?').run(customer.id);
    audit(req,null,'customer_backup_service',{enabled:req.body.backupServiceEnabled});
    return customerServices(customer);
  });
}
