import _ from 'lodash';
import Promise from 'bluebird';
import uuid from 'uuid';

import nd from './neo4jDesktop/index';
import ClusterManager from './cluster/ClusterManager';
import queryLibrary from './data/queries/query-library';
import sentry from './sentry/index';
import ClusterMember from './cluster/ClusterMember';
import DataFeed from './data/DataFeed';
import neo4j from './driver';
import neo4jErrors from './driver/errors';
import errors from './driver/errors';

/**
 * HalinContext is a controller object that keeps track of state and permits diagnostic
 * reporting.
 * 
 * It creates its own drivers and does not use the Neo4j Desktop API provided drivers.
 * The main app will attach it to the window object as a global.
 */
export default class HalinContext {
    constructor() {
        this.project = null;
        this.graph = null;
        this.drivers = {};
        this.dataFeeds = {};
        this.pollRate = 1000;
        this.clusterMembers = null;
        this.driverOptions = {
            connectionTimeout: 15000,
            trust: 'TRUST_CUSTOM_CA_SIGNED_CERTIFICATES',
        };
        this.debug = false;
        this.mgr = new ClusterManager(this);
    }

    members() {
        return this.clusterMembers;
    }

    getWriteMember() {
        const writer = this.clusterMembers.filter(cm => cm.canWrite())[0];

        if (!writer) {
            throw new Error(`
                Cluster has no write members! This could mean that it is broken,
                or is currently undergoing a leader election.
            `);
        }

        return writer;
    }

    getPollRate() {
        return this.pollRate;
    }

    /**
     * @returns {ClusterManager}
     */
    getClusterManager() {
        return this.mgr;
    }

    getFeedsFor(clusterMember) {
        return _.values(this.dataFeeds).filter(df => df.node === clusterMember);
    }

    getDataFeed(feedOptions) {
        const df = new DataFeed(feedOptions);
        const feed = this.dataFeeds[df.name];
        if (feed) {
            return feed;
        }
        this.dataFeeds[df.name] = df;
        // sentry.fine('Halin starting new DataFeed: ', df.name.slice(0, 120) + '...');
        df.start();
        return df;
    }

    /**
     * Create a new driver for a given address.
     */
    driverFor(addr, username = _.get(this.base, 'username'), password = _.get(this.base, 'password')) {
        const tlsLevel = _.get(this.base, 'tlsLevel');
        const encrypted = (tlsLevel === 'REQUIRED' ? true : false);

        if (this.drivers[addr]) {
            return this.drivers[addr];
        }

        const allOptions = _.merge({ encrypted }, this.driverOptions);
        if (this.debug) {
            sentry.fine('Driver connection', { addr, username, allOptions });
        }
        const driver = neo4j.driver(addr,
            neo4j.auth.basic(username, password), allOptions);

        this.drivers[addr] = driver;
        return driver;
    }

    shutdown() {
        sentry.info('Shutting down halin context');
        _.values(this.dataFeeds).map(df => df.stop());
        Promise.all(this.clusterMembers.map(node => node.shutdown()))
            .catch(err => sentry.reportError(err, 'Failure to shut down cluster members', err));
        _.values(this.drivers).map(driver => driver.close());
        this.getClusterManager().addEvent({
            type: 'halin',
            message: 'Halin monitoring shut down',
        });
    }

    /**
     * Returns true if the context is attached to a Neo4j Enterprise Edition server
     * with more than one cluster node.
     */
    isCluster() {
        // Must have more than one node
        return this.clusterMembers && this.clusterMembers.length > 1;
    }

    /**
     * Returns true if the context is attached to a Neo4j Enterprise edition server,
     * false otherwise.
     */
    isEnterprise() {
        return this.getWriteMember().isEnterprise();
    }

    isCommunity() {
        return !this.isEnterprise();
    }

    /**
     * @returns true if the HalinContext is attached to a Neo4j Cloud instance, false otherwise.
     */
    isNeo4jCloud() {
        const uri = this.getBaseURI();
        return (uri || '').toLowerCase().indexOf('databases.neo4j.io') > -1;
    }

    userIsAdmin() {
        // On community, there are no roles so all users have admin privileges.  Everyone else
        // requires the admin role.
        return !this.isEnterprise() || this.getCurrentUser().roles.indexOf('admin') > -1;
    }

    supportsAPOC() {
        return this.getWriteMember().supportsAPOC();
    }

    supportsLogStreaming() {
        return this.getWriteMember().supportsLogStreaming();
    }

    supportsMetrics() {
        return this.getWriteMember().metrics && this.clusterMembers[0].metrics.length > 0;
    }

    supportsDBStats() {
        return this.getWriteMember().supportsDBStats();
    }

    /**
     * Returns true if the context provides for native auth management, false otherwise.
     */
    supportsNativeAuth() {
        return this.getWriteMember().supportsNativeAuth();
    }

    /**
     * Returns true if context provides for the system graph, which is generally
     * Neo4j >= 3.6.  False otherwise.
     */
    supportsSystemGraph() {
        return this.getWriteMember().supportsSystemGraph();
    }

    /**
     * Returns true if the context supports authorization overall.
     */
    supportsAuth() {
        return this.getWriteMember().supportsAuth();
    }

    getVersion() {
        return this.getWriteMember().getVersion();
    }

    /**
     * Starts a slow data feed for the node's cluster role.  In this way, if the leader
     * changes, we can detect it.
     */
    watchForClusterRoleChange(clusterMember) {
        const roleFeed = this.getDataFeed(_.merge({
            node: clusterMember,
        }, queryLibrary.CLUSTER_ROLE));

        const addr = clusterMember.getBoltAddress();
        const onRoleData = (newData /* , dataFeed */) => {
            const newRole = newData.data[0].role;

            // Something in cluster topology just changed...
            if (newRole !== clusterMember.role) {
                const oldRole = clusterMember.role;
                clusterMember.role = newRole;

                const event = {
                    message: `Role change from ${oldRole} to ${newRole}`,
                    type: 'rolechange',
                    address: clusterMember.getBoltAddress(),
                    payload: {
                        old: oldRole,
                        new: newRole,
                    },
                };

                this.getClusterManager().addEvent(event);
            }
        };

        const onError = (err /*, dataFeed */) => 
            sentry.reportError(err, `HalinContext: failed to get cluster role for ${addr}`);

        roleFeed.addListener(onRoleData);
        roleFeed.onError = onError;
        return roleFeed;
    }

    /**
     * Check to see if the active database is a cluster.  In this context cluster means that it's Neo4j Enterprise
     * and the dbms.cluster.* procedures are present (e.g. not mode=SINGLE).
     * @param {Object} activeDb 
     */
    checkForCluster(activeDb, progressCallback) {
        const session = this.base.driver.session();
        // sentry.debug('activeDb', activeDb);

        const report = str => progressCallback ? progressCallback(str) : null;

        report('Checking cluster status');
        return session.run(queryLibrary.CLUSTER_OVERVIEW.query)
            .then(results => {
                this.clusterMembers = results.records.map(rec => new ClusterMember(rec));

                // Note that in the case of community or mode=SINGLE, because the cluster overview fails,
                // this will never take place.  Watching for cluster role changes doesn't apply in those cases.
                return this.clusterMembers.map(clusterMember => {
                    const driver = this.driverFor(clusterMember.getBoltAddress());
                    clusterMember.setDriver(driver);
                    report(`Member ${clusterMember.getLabel()} initialized`);
                    return this.watchForClusterRoleChange(clusterMember);
                });
            })
            .catch(err => {
                if (errors.noProcedure(err)) {
                    // Halin will look at single node databases
                    // running in desktop as clusters of size 1.
                    // #operability I wish Neo4j treated mode=SINGLE as a cluster of 1 and exposed dbms.cluster.*
                    const rec = {
                        id: uuid.v4(),
                        addresses: nd.getAddressesForGraph(activeDb.graph),
                        role: 'SINGLE',
                        database: 'default',
                    };

                    // Psuedo object behaves like a cypher result record.
                    // Somewhere, a strong typing enthusiast is screaming. ;)
                    const get = key => rec[key];
                    rec.get = get;

                    const singleton = new ClusterMember(rec);
                    const driver = this.driverFor(singleton.getBoltAddress());
                    singleton.setDriver(driver);
                    this.clusterMembers = [singleton];
                } else {
                    sentry.reportError(err);
                    throw err;
                }
            })
            .then(() => report('Verifying connectivity with members...'))
            .then(() => 
                Promise.all(this.clusterMembers.map(cn => this.ping(cn))))
            .then(() => report('Checking components/features for each cluster member...'))
            .then(() => Promise.all(this.clusterMembers.map(cn => cn.checkComponents())))
            .finally(() => session.close());
    }

    getCurrentUser() {
        return this.currentUser;
    }

    checkUser(driver /*, progressCallback */) {
        const q = 'call dbms.showCurrentUser()';
        const session = driver.session();

        return session.run(q, {})
            .then(results => {
                const rec = results.records[0];

                this.currentUser = {
                    username: rec.get('username'),
                    // Community doesn't have roles.
                    roles: rec.has('roles') ? rec.get('roles') : [],
                    flags: rec.get('flags'),
                };
                
                // sentry.fine('Current User', this.currentUser);
            })
            .catch(err => {
                if (neo4jErrors.noProcedure(err)) {
                    // This occurs when dbms.security.auth_enabled=false and neo4j
                    // does not even expose auth-related procedures.  But it isn't
                    // an error.
                    this.currentUser = {
                        username: 'neo4j',
                        roles: [],
                        flags: [],
                    };
                } else {
                    sentry.reportError(err, 'Failed to get user info');
                    this.currentUser = {
                        username: 'UNKNOWN',
                        roles: [],
                        flags: [],
                    };
                }
            })
            .finally(() => session.close());
    }

    static getProjectFromEnvironment() {
        return {
            name: process.env.GRAPH_NAME || 'environment',
            graphs: [
                HalinContext.getGraphFromEnvironment(),
            ],
        };
    }

    static getGraphFromEnvironment() {
        const encryption = process.env.ENCRYPTION_REQUIRED ? 'REQUIRED' : 'OPTIONAL';
        const host = process.env.NEO4J_HOST || 'localhost';
        const port = process.env.NEO4J_PORT || 7687;
        const username = process.env.NEO4J_USERNAME || 'neo4j';
        const password = process.env.NEO4J_PASSWORD || 'admin';

        return {
            name: process.env.GRAPH_NAME || 'environment',
            status: process.env.GRAPH_STATUS || 'ACTIVE',
            databaseStatus: process.env.DATABASE_STATUS || 'RUNNING',
            databaseType: process.env.DATABASE_TYPE || 'neo4j',
            id: process.env.DATABASE_UUID || uuid.v4(),
            connection: {
                configuration: {
                    path: '.',
                    protocols: {
                        bolt: {
                            host,
                            port,
                            username,
                            password,
                            enabled: true,
                            tlsLevel: encryption,
                        },
                    },
                },
            },
        };
    }

    getBaseURI() {
        return `bolt://${this.base.host}:${this.base.port}`;
    }

    /**
     * Returns a promise that resolves to the HalinContext object completed,
     * or rejects.
     * 
     * There are three major code paths here:
     * (1) Running in Neo4j desktop, use that API to figure what graph to 
     * connect to.
     * (2) Running in browser (not desktop) -- in which case we needed to
     * fake the neo4j desktop API facade prior to this step
     * (3) Running in terminal (and window object isn't even defined)
     */
    initialize(progressCallback = null) {
        let inBrowser = true;

        const report = str => {
            if (progressCallback) {
                return progressCallback(str, this);
            }
            return null;
        };

        try {
            // Will fail with ReferenceError if not in a browser.
            // eslint-disable-next-line
            const globalWindow = window;
        } catch (e) {
            inBrowser = false;
        }

        try {
            let getGraphSpecificsPromise = null;

            if (!inBrowser) {
                // No need to fake a neo4jdesktop API.  Construct
                // needed context directly from env vars.
                getGraphSpecificsPromise = Promise.resolve({
                    project: HalinContext.getProjectFromEnvironment(),
                    graph: HalinContext.getGraphFromEnvironment(),
                });
            } else {
                getGraphSpecificsPromise = nd.getFirstActive();
            }

            report('Getting database connection');
            return getGraphSpecificsPromise.then(active => {
                    if (_.isNil(active)) {
                        // In the web version, this will never happen because the
                        // shim will fake an active DB.  In Neo4j Desktop this 
                        // **will** happen if the user launches Halin without an 
                        // activated database.
                        throw new Error('In order to launch Halin, you must have an active database connection');
                    }

                    // sentry.fine('FIRST ACTIVE', active);
                    this.project = active.project;
                    this.graph = active.graph;

                    this.base = _.cloneDeep(active.graph.connection.configuration.protocols.bolt);

                    // Create a default driver to have around.
                    this.base.driver = this.driverFor(this.getBaseURI());

                    // sentry.fine('HalinContext created', this);
                    return Promise.all([
                        this.checkUser(this.base.driver, progressCallback),
                        this.checkForCluster(active, progressCallback),
                    ]);
                })
                .then(() => {
                    this.getClusterManager().addEvent({
                        type: 'halin',
                        message: 'Halin monitoring started',
                        address: 'all members',
                    });
                    report('Initialization complete');
                    return this;
                });
        } catch (e) {
            sentry.reportError(e, 'General Halin Context Error');
            try { this.shutdown(); }
            catch (err) {
                sentry.reportError(err, 'Failure to shut down post halin context error');
            }
            return Promise.reject(new Error('General Halin Context error', e));
        }
    }

    /**
     * Ping a cluster node with a trivial query, just to keep connections
     * alive and verify it's still listening.  This forces driver creation
     * for a node if it hasn't already happened.
     * @param {ClusterMember} the node to ping
     * @returns {Promise} that resolves to an object with an elapsedMs field
     * or an err field populated.
     */
    ping(clusterMember) {
        const addr = clusterMember.getBoltAddress();

        // Gets or creates a ping data feed for this cluster node.
        // Data feed keeps running so that we can deliver the data to the user,
        // but also have a feed of data to know if the cord is getting unplugged
        // as the app runs.
        const pingFeed = this.getDataFeed(_.merge({
            node: clusterMember,
        }, queryLibrary.PING));

        // Caller needs a promise.  The feed is already running, so 
        // We return a promise that resolves the next time the data feed
        // comes back with a result.
        return new Promise((resolve, reject) => {
            const onPingData = (newData /* , dataFeed */) => {
                return resolve({
                    clusterMember: clusterMember,
                    elapsedMs: _.get(newData, 'data[0]_sampleTime'),
                    newData,
                    err: null,
                });
            };

            const onError = (err, dataFeed) => {
                sentry.error('HalinContext: failed to ping', addr, err);
                reject(err, dataFeed);
            };

            pingFeed.addListener(onPingData);
            pingFeed.onError = onError;
        });
    }
}