'use strict';


const winston = require('winston');
const async = require('async');
const _ = require('lodash');

const nconf = require.main.require('nconf');

const db = require.main.require('./src/database');
const topics = require.main.require('./src/topics');
const posts = require.main.require('./src/posts');
const utils = require.main.require('./src/utils');
const socketAdmin = require.main.require('./src/socket.io/admin');
const batch = require.main.require('./src/batch');
const plugins = require.main.require('./src/plugins');
const categories = require.main.require('./src/categories');
const pubsub = require.main.require('./src/pubsub');
const nodejieba = require("nodejieba");

const searchModule = require('./' + nconf.get('database'));

db.searchIndex = searchModule.searchIndex;
db.search = searchModule.search;
db.searchRemove = searchModule.searchRemove;

const languageLookup = {
	da: 'danish',
	nl: 'dutch',
	en: 'english',
	fi: 'finnish',
	fr: 'french',
	de: 'german',
	hu: 'hungarian',
	it: 'italian',
	nb: 'norwegian',
	pt: 'portuguese',
	ro: 'romanian',
	ru: 'russian',
	es: 'spanish',
	sv: 'swedish',
	tr: 'turkish',
};

const defaultPostLimit = 500;
const defaultTopicLimit = 500;

let pluginConfig = {
	postLimit: defaultPostLimit,
	topicLimit: defaultTopicLimit,
	excludeCategories: [],
};

var batchSize = 500;

const search = module.exports;

function convertLanguageName(name) {
	if (nconf.get('database') === 'postgres') {
		return languageLookup[name] || languageLookup.en;
	}
	return name;
}

search.init = async function (params) {
	params.router.get('/admin/plugins/dbsearch', params.middleware.applyCSRF, params.middleware.admin.buildHeader, renderAdmin);
	params.router.get('/api/admin/plugins/dbsearch', params.middleware.applyCSRF, renderAdmin);

	params.router.post('/api/admin/plugins/dbsearch/save', params.middleware.applyCSRF, save);

	pluginConfig = await getPluginData();
	await searchModule.createIndices(convertLanguageName(pluginConfig ? pluginConfig.indexLanguage || 'en' : 'en'));

	pubsub.on('nodebb-plugin-dbsearch:settings:save', function (data) {
		Object.assign(pluginConfig, data);
	});
};

search.actionPostSave = async function (data) {
	const isDeleted = await topics.getTopicField(data.post.tid, 'deleted');
	if (!isDeleted) {
		await postsSave([data.post]);
	}
};

search.actionPostRestore = function (data) {
	search.actionPostSave(data);
};

search.actionPostEdit = function (data) {
	search.actionPostSave(data);
};

search.actionPostDelete = function (data) {
	searchRemove('post', [data.post.pid]);
};

search.actionPostPurge = function (data) {
	searchRemove('post', [data.post.pid]);
};

search.actionPostMove = async function (data) {
	const topicData = await topics.getTopicFields(data.post.tid, ['cid', 'deleted']);
	reIndexPids([data.post.pid], topicData);
};

search.actionTopicSave = function (data) {
	topicsSave([data.topic]);
};

search.actionTopicRestore = function (data) {
	reIndexTids([data.topic.tid]);
};

search.actionTopicEdit = function (data) {
	search.actionTopicSave(data);
};

search.actionTopicDelete = async function (data) {
	if (!data || !data.topic) {
		return;
	}
	const tid = data.topic.tid;
	await Promise.all([
		searchRemove('topic', [tid]),
		searchRemove('post', [data.topic.mainPid]),
		batch.processSortedSet('tid:' + tid + ':posts', async function (pids) {
			await searchRemove('post', pids);
		}, {
			batch: batchSize,
		}),
	]);
};

search.actionTopicPurge = function (data) {
	search.actionTopicDelete(data);
};

search.actionTopicMove = function (data) {
	reIndexTids([data.tid]);
};

search.filterSearchQuery = async function (data) {
	if (!data || !data.index) {
		return [];
	}
	const limit = data.index === 'post' ? pluginConfig.postLimit : pluginConfig.topicLimit;
	const query = {};
	if (data.hasOwnProperty('cid')) {
		query.cid = data.cid;
	}
	if (data.hasOwnProperty('uid')) {
		query.uid = data.uid;
	}
	if (data.hasOwnProperty('content')) {
		query.content = data.content;
	}
	if (!Object.keys(query).length) {
		return [];
	}
	if (data.hasOwnProperty('matchWords')) {
		query.matchWords = data.matchWords;
	}
	query.searchData = data.searchData || {};
	return await db.search(data.index, query, limit);
};

search.filterSearchTopic = async function (hookData) {
	if (!hookData.term || !hookData.tid) {
		return [];
	}
	const cid = await topics.getTopicField(hookData.tid, 'cid');
	const pids = await search.filterSearchQuery({
		index: 'post',
		cid: [cid],
		content: hookData.term,
	});
	const postData = await posts.getPostsFields(pids, ['pid', 'tid']);
	return postData.filter(p => p && p.tid === parseInt(hookData.tid, 10))
		.map(p => p.pid);
};

search.reindex = async function () {
	await db.setObject('nodebb-plugin-dbsearch', {
		topicsIndexed: 0,
		postsIndexed: 0,
		working: 1,
	});
	await Promise.all([
		reIndexTopics(),
		reIndexPosts(),
	]);
	await db.setObject('nodebb-plugin-dbsearch', {
		working: 0,
	});
};

async function reIndexTopics() {
	await batch.processSortedSet('topics:tid', async function (tids) {
		const topicData = await topics.getTopicsFields(tids, ['tid', 'title', 'uid', 'cid', 'deleted']);
		await topicsSave(topicData);
	}, {
		batch: batchSize,
	});
}

function tokenize(text) {
	var result = nodejieba.cutHMM(text);
	if (text.length < 500)
		return result.join(' ') + " " + text;
	else
		return result.join(' ');
}

async function topicsSave(topics) {
	topics = topics.filter(t => t && t.tid && parseInt(t.deleted, 10) !== 1 && !pluginConfig.excludeCategories.includes(String(t.cid)));

	let data = topics.map(function (topicData) {
		const indexData = {};
		if (topicData.title) {
			indexData.content = tokenize(topicData.title);
		}
		if (topicData.cid) {
			indexData.cid = topicData.cid;
		}
		if (topicData.uid) {
			indexData.uid = topicData.uid;
		}
		if (!Object.keys(indexData).length) {
			return null;
		}
		return indexData;
	});

	const tids = topics.filter((t, index) => !!data[index]).map(t => t.tid);
	data = data.filter(Boolean);
	if (!data.length) {
		return;
	}

	const result = await plugins.hooks.fire('filter:search.indexTopics', { data: data, tids: tids, topics: topics });
	await db.searchIndex('topic', result.data, result.tids);
	await db.incrObjectFieldBy('nodebb-plugin-dbsearch', 'topicsIndexed', result.tids.length);
}

async function reIndexPosts() {
	await batch.processSortedSet('posts:pid', async function (pids) {
		let postData = await posts.getPostsFields(pids, ['pid', 'content', 'uid', 'tid', 'deleted']);
		postData = postData.filter(p => p && p.deleted !== 1);
		const tids = _.uniq(postData.map(p => p.tid));
		const topicData = await topics.getTopicsFields(tids, ['deleted', 'cid']);
		const tidToTopic = _.zipObject(tids, topicData);
		postData.forEach(function (post) {
			if (post && tidToTopic[post.tid]) {
				post.cid = tidToTopic[post.tid].cid;
			}
		});
		postData = postData.filter(post => tidToTopic[post.tid].deleted !== 1);
		await postsSave(postData);
	}, {
		batch: batchSize,
	});
}

async function postsSave(posts) {
	posts = posts.filter(p => p && p.pid && parseInt(p.deleted, 10) !== 1 && !pluginConfig.excludeCategories.includes(String(p.cid)));

	let data = posts.map(function (postData) {
		const indexData = {};
		if (postData.content) {
			indexData.content = tokenize(postData.content);
		}
		if (postData.cid) {
			indexData.cid = postData.cid;
		}
		if (postData.uid) {
			indexData.uid = postData.uid;
		}
		if (!Object.keys(indexData).length) {
			return null;
		}
		return indexData;
	});

	const pids = posts.filter((p, index) => !!data[index]).map(p => p.pid);
	data = data.filter(Boolean);
	if (!data.length) {
		return;
	}

	const result = await plugins.hooks.fire('filter:search.indexPosts', { data: data, pids: pids, posts: posts });
	await db.searchIndex('post', result.data, result.pids);
	await db.incrObjectFieldBy('nodebb-plugin-dbsearch', 'postsIndexed', result.pids.length);
}

async function searchRemove(key, ids) {
	await db.searchRemove(key, ids);
	if (key === 'topic') {
		await db.incrObjectFieldBy('nodebb-plugin-dbsearch', 'topicsIndexed', -ids.length);
	} else if (key === 'post') {
		await db.incrObjectFieldBy('nodebb-plugin-dbsearch', 'postsIndexed', -ids.length);
	}
}

async function reIndexTids(tids) {
	if (!Array.isArray(tids) || !tids.length) {
		return;
	}

	let topicData = await topics.getTopicsFields(tids, ['tid', 'title', 'uid', 'cid', 'deleted', 'mainPid']);
	topicData = topicData.filter(t => t.tid && t.deleted !== 1);
	if (!topicData.length) {
		return;
	}
	await Promise.all([
		topicsSave(topicData),
		async.each(topicData, async function (topic) {
			await reIndexPids([topic.mainPid], topic);
			await batch.processSortedSet('tid:' + topic.tid + ':posts', async function (pids) {
				await reIndexPids(pids, topic);
			}, {
				batch: batchSize,
			});
		}),
	]);
}

async function reIndexPids(pids, topic) {
	if (!Array.isArray(pids) || !pids.length) {
		winston.warn('[nodebb-plugin-dbsearch] invalid-pid, skipping');
		return;
	}
	if (parseInt(topic.deleted, 10) === 1) {
		return;
	}
	const postData = await posts.getPostsFields(pids, ['pid', 'content', 'uid', 'tid', 'deleted']);
	postData.forEach(function (post) {
		if (post && topic) {
			post.cid = topic.cid;
		}
	});
	await postsSave(postData);
}

async function renderAdmin(req, res) {
	const results = await getGlobalAndPluginData();
	results.plugin.progressData = getProgress(results);
	results.plugin.csrf = req.csrfToken();
	res.render('admin/plugins/dbsearch', results.plugin);
}

async function save(req, res) {
	if (utils.isNumber(req.body.postLimit) && utils.isNumber(req.body.topicLimit)) {
		var data = {
			postLimit: req.body.postLimit,
			topicLimit: req.body.topicLimit,
			excludeCategories: JSON.stringify(req.body.excludeCategories || []),
		};

		await db.setObject('nodebb-plugin-dbsearch', data);

		pluginConfig.postLimit = data.postLimit;
		pluginConfig.topicLimit = data.topicLimit;
		pluginConfig.excludeCategories = req.body.excludeCategories || [];
		pubsub.publish('nodebb-plugin-dbsearch:settings:save', pluginConfig);
		res.json('Settings saved!');
	}
}

socketAdmin.plugins.dbsearch = {};
socketAdmin.plugins.dbsearch.checkProgress = async function () {
	const results = await getGlobalAndPluginData();
	return getProgress(results);
};

async function getPluginData() {
	const data = await db.getObject('nodebb-plugin-dbsearch') || {};
	data.topicsIndexed = parseInt(data.topicsIndexed, 10) || 0;
	data.postsIndexed = parseInt(data.postsIndexed, 10) || 0;
	data.excludeCategories = data.excludeCategories || '[]';
	data.postLimit = data.postLimit || defaultPostLimit;
	data.topicLimit = data.topicLimit || defaultTopicLimit;
	data.indexLanguage = data.indexLanguage || 'en';
	data.working = data.working || 0;

	try {
		data.excludeCategories = JSON.parse(data.excludeCategories);
	} catch (err) {
		winston.error(err);
		data.excludeCategories = [];
	}
	return data;
}

async function getGlobalAndPluginData() {
	const [global, plugin, allCategories] = await Promise.all([
		db.getObjectFields('global', ['topicCount', 'postCount']),
		getPluginData(),
		categories.buildForSelectAll(['value', 'text']),
	]);

	const languageSupported = nconf.get('database') === 'mongo' || nconf.get('database') === 'postgres';
	const languages = Object.keys(languageLookup).map(function (code) {
		return { name: languageLookup[code], value: code, selected: false };
	});

	plugin.languageSupported = languageSupported;
	plugin.languages = languages;

	plugin.allCategories = allCategories;
	plugin.topicCount = parseInt(global.topicCount, 10);
	plugin.postCount = parseInt(global.postCount, 10);
	plugin.topicLimit = plugin.topicLimit || defaultTopicLimit;
	plugin.postLimit = plugin.postLimit || defaultPostLimit;
	plugin.topicsIndexed = plugin.topicsIndexed > plugin.topicCount ? plugin.topicCount : plugin.topicsIndexed;
	plugin.postsIndexed = plugin.postsIndexed > plugin.postCount ? plugin.postCount : plugin.postsIndexed;
	plugin.languageSupported = languageSupported;
	plugin.languages = languages;
	plugin.indexLanguage = plugin.indexLanguage || 'en';
	plugin.languages.forEach(function (language) {
		language.selected = language && language.value === plugin.indexLanguage;
	});

	plugin.allCategories.forEach(function (category) {
		category.selected = category && plugin.excludeCategories.includes(String(category.value));
	});

	return { global: global, plugin: plugin, allCategories: allCategories };
}

function getProgress(results) {
	const topicsPercent = results.global.topicCount ? (results.plugin.topicsIndexed / results.global.topicCount) * 100 : 0;
	const postsPercent = results.global.postCount ? (results.plugin.postsIndexed / results.global.postCount) * 100 : 0;
	return {
		topicsPercent: Math.max(0, Math.min(100, topicsPercent.toFixed(2))),
		postsPercent: Math.max(0, Math.min(100, postsPercent.toFixed(2))),
		topicsIndexed: topicsPercent >= 100 ? results.global.topicCount : Math.max(0, results.plugin.topicsIndexed),
		postsIndexed: postsPercent >= 100 ? results.global.postCount : Math.max(0, results.plugin.postsIndexed),
		working: results.plugin.working,
	};
}

socketAdmin.plugins.dbsearch.reindex = function (socket, data, callback) {
	try {
		search.reindex();
	} catch (err) {
		winston.error(err);
	}
	callback();
};

socketAdmin.plugins.dbsearch.clearIndex = function (socket, data, callback) {
	try {
		clearIndex();
	} catch (err) {
		winston.error(err);
	}
	callback();
};

async function clearIndex() {
	await db.setObject('nodebb-plugin-dbsearch', {
		working: 1,
	});

	await Promise.all([
		clearSet('topics:tid', 'topic'),
		clearSet('posts:pid', 'post'),
	]);

	await db.setObject('nodebb-plugin-dbsearch', {
		postsIndexed: 0,
		topicsIndexed: 0,
		working: 0,
	});
}

async function clearSet(set, key) {
	await batch.processSortedSet(set, async function (ids) {
		await searchRemove(key, ids);
	}, {
		batch: batchSize,
	});
}

socketAdmin.plugins.dbsearch.changeLanguage = async function (socket, language) {
	await searchModule.changeIndexLanguage(convertLanguageName(language));
	await db.setObject('nodebb-plugin-dbsearch', { indexLanguage: language });
};

const admin = {};
admin.menu = function (custom_header, callback) {
	custom_header.plugins.push({
		route: '/plugins/dbsearch',
		icon: 'fa-search',
		name: 'DB Search (Jieba version)',
	});

	callback(null, custom_header);
};

search.admin = admin;
