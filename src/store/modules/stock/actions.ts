import { ActionTree } from 'vuex'
import store from '@/store'
import RootState from '@/store/RootState'
import StockState from './StockState'
import * as types from './mutation-types'
import { showToast } from '@/utils';
import { hasError } from "@/adapter";
import { StockService } from "@/services/StockService";
import { translate } from "@hotwax/dxp-components";
import logger from "@/logger";
import { DateTime } from 'luxon'
import router from '@/router'

const actions: ActionTree<StockState, RootState> = {
  async processUpdateStockItems ({ commit, rootGetters }, items) {
    this.dispatch('util/updateFileProcessingStatus', true);

    //Fetching only top 
    const productIds = items.slice(0, process.env['VUE_APP_VIEW_SIZE']).map((item: any) => item.identification);


    // We are getting external facilityId from CSV, extract facilityId and pass for getting locations
    const externalFacilityIds = [...new Set(items.map((item: any) => item.externalFacilityId))]
    const facilities = await store.dispatch('util/fetchFacilities');
    const facilityMapping = facilities.reduce((facilityMapping: any, facility: any) => {
      if (facility.externalId) facilityMapping[facility.externalId] = facility.facilityId;
      return facilityMapping;
    }, {})
    const facilityIds = externalFacilityIds.map((externalFacilityId: any) => {
      return facilityMapping[externalFacilityId];
    }).filter((facilityId: any) => facilityId)
    store.dispatch('util/fetchFacilityLocations', facilityIds);
    

    const viewSize = productIds.length;
    const viewIndex = 0;
    const payload = {
      viewSize,
      viewIndex,
      productIds,
      identificationTypeId: items[0]?.identificationTypeId //fetching identificationTypeId from first item, as all the items will have one identification type
    }
    const cachedProducts = await store.dispatch("product/fetchProducts", payload);
    const parsed = [] as any;
    const initial = items.map((item: any) => {
      const product = cachedProducts[item.identification];
      const facilityLocation = rootGetters['util/getFacilityLocationsByFacilityId'](item.externalFacilityId)?.[0];
      item.locationSeqId = facilityLocation?.locationSeqId;
      parsed.push(item);
      
      if (product) {
        item.parentProductId = product?.parent?.id;
        item.pseudoId = product.pseudoId;
        item.parentProductName = product?.parent?.productName;
        item.imageUrl = product.images?.mainImageUrl;
        item.isSelected = true;
        return item;
      }
      return;
    }).filter((item: any) => item);

    const original = JSON.parse(JSON.stringify(items));
    commit(types.STOCK_ITEMS_UPDATED, { parsed, original, initial });
    this.dispatch('util/updateFileProcessingStatus', false);
  },
  updateStockItems({ commit }, stockItems){
    commit(types.STOCK_ITEMS_UPDATED, stockItems);
  },
  clearStockItems({ commit }){
    commit(types.STOCK_ITEMS_UPDATED, { parsed: [], original: []});
  },
  async processUpdateRestockItems({ commit }, items) {
  
    const productIds = items.filter((item: any) => item.product).map((item: any) => item.product);
  
    const payload = {
      productIds,
      identificationTypeId: items[0]?.identificationTypeId
    };
  
    const externalFacilityIds = [...new Set(items.map((item: any) => item.externalFacilityId))];
    const facilities = await store.dispatch('util/fetchFacilities');
    const facilityMapping = facilities.reduce((facilityMapping: any, facility: any) => {
      if (facility.externalId) facilityMapping[facility.externalId] = facility.facilityId;
      return facilityMapping;
    }, {});
    const facilityIds = externalFacilityIds.map((externalFacilityId: any) => facilityMapping[externalFacilityId]).filter((facilityId: any) => facilityId);
    const cachedProducts = await store.dispatch("product/fetchProducts", payload);

    const initial = items.map((item: any) => {
      const product = cachedProducts[item.product];
      
      if (product) {
        item.parentProductId = product?.parent?.id;
        item.pseudoId = product.pseudoId;
        item.parentProductName = product?.parent?.productName;
        item.productId = product.productId
        item.imageUrl = product.images?.mainImageUrl;
        item.isSelected = true;
        return item;
      }
      return;
    }).filter((item: any) => item);
  
    commit(types.STOCK_SCHEDULE_ITEMS_UPDATED, initial );
  },
  clearRetockItems({ commit }) {
    commit(types.STOCK_SCHEDULE_ITEMS_UPDATED, []);
  },
  async scheduledStock({ commit }, payload) {
    commit(types.STOCK_SCHEDULED_INFORMATION, payload)
  },

  async shopifyShop({ commit }, payload) {
    commit(types.STOCK_SHOPIFY_SHOPS_UPDATED, payload)
  },
  
  async scheduleService({ dispatch, state }, { params, restockName }) {
    let resp;

      const job = await dispatch("fetchDraftJob")

      if(!job.jobId) {
        showToast(translate("Configuration missing"))
        return;
      }

      const payload = {
        'JOB_NAME': restockName || state.schedule.restockName || `Created ${DateTime.now().toLocaleString(DateTime.DATETIME_MED)}`,
        'SERVICE_NAME': "shipPackedOrders", // TODO: make dynamic
        'SERVICE_COUNT': '0',
        'SERVICE_TEMP_EXPR': job.jobStatus,
        'SERVICE_RUN_AS_SYSTEM':'Y',
        'jobFields': {
          'systemJobEnumId': job.systemJobEnumId,
          'tempExprId': job.jobStatus, // Need to remove this as we are passing frequency in SERVICE_TEMP_EXPR, currently kept it for backward compatibility
          'maxRecurrenceCount': '-1',
          'parentJobId': job.parentJobId,
          'runAsUser': 'system', //default system, but empty in run now.  TODO Need to remove this as we are using SERVICE_RUN_AS_SYSTEM, currently kept it for backward compatibility
          'recurrenceTimeZone': this.state.user.current.userTimeZone,
          'createdByUserLogin': this.state.user.current.userLoginId,
          'lastModifiedByUserLogin': this.state.user.current.userLoginId,
        },
        'statusId': "SERVICE_PENDING",
        'systemJobEnumId': job.systemJobEnumId,
        ...params
      }

      job?.priority && (payload['SERVICE_PRIORITY'] = job.priority.toString())
      payload['SERVICE_TIME'] = state.schedule.scheduledTime.toString()
      job?.sinceId && (payload['sinceId'] = job.sinceId)

      try {
        resp = await StockService.scheduleJob({ ...payload });
        if (resp.status == 200 && !hasError(resp)) {
          showToast(translate('Service has been scheduled'));
        } else {
          showToast(translate('Something went wrong'))
        }
      } catch (err) {
        showToast(translate('Something went wrong'))
        logger.error(err)
      }
      return {};
  },
 
  async fetchDraftJob() {
    let resp, job: any = {};

    const payload = {
      "inputFields": {
        "statusId": "SERVICE_DRAFT",
        "statusId_op": "equals",
        "systemJobEnumId": "JOB_RST_STK",
        "systemJobEnumId_op": "equals"
      },
      "fieldList": [ "systemJobEnumId", "runTime", "tempExprId", "parentJobId", "serviceName", "jobId", "jobName", "currentRetryCount", "statusId", "runtimeDataId", "productStoreId", "priority"],
      "noConditionFind": "Y",
      "viewSize": 1,
      "orderBy": "runTime ASC"
    }

    try {
      resp = await StockService.fetchJobInformation(payload)

      if(!hasError(resp) && resp.data.docs.length) {
        job = resp.data.docs[0]

        job = {
          ...job,
          status: job.statusId,
          enumId: job.systemJobEnumId,
          frequency: job.tempExprId,
          id: job.jobId
        }
      } else {
        throw resp.data
      }
    } catch(err) {
      logger.error('Failed to fetcg draft job')
      job = {}
    }

    return job;
  },

  async fetchJobs ({ commit }) {
    let resp;

    try{
      const params = {
        "inputFields": {
          "statusId": "SERVICE_PENDING",
          'systemJobEnumId': "JOB_RST_STK",
          'systemJobEnumId_op': 'equals',
          'orderBy': 'runTime ASC'
        },
        "noConditionFind": "Y",
        "viewSize": 50
      } as any
  
      resp = await StockService.fetchJobInformation(params)
  
      if(!hasError(resp) && resp.data.count > 0) {
        const jobs = resp.data.docs
        commit(types.STOCK_JOBS_UPDATED, jobs);
      } else {
          commit(types.STOCK_JOBS_UPDATED, []);
      } 
    } catch(error) {
      logger.error(error);
    }
    return resp
  },
  async updateMissingFacilities({ state }, facilityMapping){
    const facilityLocations = await this.dispatch('util/fetchFacilityLocations', Object.values(facilityMapping));
    Object.keys(facilityMapping).map((facilityId: any) => {
      const locationSeqId = facilityLocations[facilityMapping[facilityId]].length ? facilityLocations[facilityMapping[facilityId]][0].locationSeqId : '';
      state.items.parsed.map((item: any) => {
        if(item.externalFacilityId === facilityId){
          item.externalFacilityId = "";
          item.facilityId = facilityMapping[facilityId];
          item.locationSeqId = locationSeqId;
        }
      })
    })
    this.dispatch('stock/updateStockItems', state.items);
  }
}

export default actions;
