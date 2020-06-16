const _ = require('underscore');
const async = require('async');
const fs = require('fs');
const https = require('https');
const { LightningBackend } = require('../../');
const url = require('url');

class Backend extends LightningBackend {

	constructor(options) {
		super('lnd', options, {
			defaultOptions: {
				hostname: '127.0.0.1:8080',
				cert: null,
				macaroon: null,
				protocol: 'https',
			},
			requiredOptions: ['hostname', 'cert', 'macaroon'],
		});
		this.prepareCertAndMacaroon();
	}

	checkOptions(options) {
		if (_.isString(options.cert)) {
			fs.statSync(options.cert);
		} else if (_.isObject(options.cert)) {
			if (!options.cert.data || (!_.isString(options.cert.data) && !Buffer.isBuffer(options.cert.data))) {
				throw new Error('Invalid option ("cert"): Expected { data: Buffer/String }');
			}
		} else {
			throw new Error('Invalid option ("cert"): Object or string expected');
		}
		if (_.isString(options.macaroon)) {
			fs.statSync(options.macaroon);
		} else if (_.isObject(options.macaroon)) {
			if (!options.macaroon.data || (!_.isString(options.macaroon.data) && !Buffer.isBuffer(options.macaroon.data))) {
				throw new Error('Invalid option ("macaroon"): Expected { data: Buffer/String }');
			}
		} else {
			throw new Error('Invalid option ("cert"): Object or string expected');
		}
	}

	prepareCertAndMacaroon() {
		const options = this.options;
		let cert, macaroon;
		if (_.isString(options.cert)) {
			cert = fs.readFileSync(options.cert).toString('utf8');
		} else {
			cert = options.cert.data;
			if (Buffer.isBuffer(cert)) {
				cert = cert.toString('utf8');
			}
		}
		if (_.isString(options.macaroon)) {
			macaroon = fs.readFileSync(options.macaroon).toString('hex');
		} else {
			macaroon = options.macaroon.data;
			if (Buffer.isBuffer(macaroon)) {
				macaroon = macaroon.toString('hex');
			}
		}
		this.cert = cert;
		this.macaroon = macaroon;
	}

	getNodeUri() {
		return this.getNodeInfo().then(info => {
			return info.uris[0];
		});
	}

	openChannel(remoteId, localAmt, pushAmt, makePrivate) {
		return this.request('post', '/v1/channels', {
			node_pubkey_string: remoteId,
			local_funding_amount: localAmt,
			push_sat: pushAmt,
			private: makePrivate,
		}).then(result => {
			if (result.funding_txid_bytes) {
				result.funding_txid_str = Buffer.from(result.funding_txid_bytes, 'base64').toString('hex');
			}
			if (_.isUndefined(result.output_index) || !_.isNumber(result.output_index)) {
				throw new Error('Unexpected response from LN Backend [POST /v1/channels]: "output_index"');
			}
			if (_.isUndefined(result.funding_txid_str) || !_.isString(result.funding_txid_str)) {
				throw new Error('Unexpected response from LN Backend [POST /v1/channels]: "funding_txid_str"');
			}
			return result;
		});
	}

	payInvoice(invoice) {
		return this.request('post', '/v1/channels/transactions', {
			payment_request: invoice,
		}).then(result => {
			if (_.isUndefined(result.payment_preimage) || !_.isString(result.payment_preimage)) {
				throw new Error('Unexpected response from LN Lightning [POST /v1/channels/transactions]: "payment_preimage"');
			}
			if (_.isUndefined(result.payment_hash) || !_.isString(result.payment_hash)) {
				throw new Error('Unexpected response from LN Lightning [POST /v1/channels/transactions]: "payment_hash"');
			}
			if (_.isUndefined(result.payment_route) || !_.isObject(result.payment_route)) {
				throw new Error('Unexpected response from LN Lightning [POST /v1/channels/transactions]: "payment_route"');
			}
			if (result.payment_error) {
				const message = result.payment_error;
				throw new Error(`Failed to pay invoice: "${message}"`);
			}
			if (!result.payment_preimage) {
				throw new Error('Probable failed payment: Did not receive payment_preimage in response');
			}
			return result;
		});
	}

	addInvoice(amount, extra) {
		const { descriptionHash } = extra;
		const descriptionHashBase64 = Buffer.from(descriptionHash, 'hex').toString('base64');
		return this.request('post', '/v1/invoices', {
			value_msat: amount,
			description_hash: descriptionHashBase64,
		}).then(result => {
			if (!result.payment_request) {
				throw new Error(`Unexpected response from LN Lightning [POST /v1/invoices]: Missing "payment_request"`);
			}
			return result.payment_request;
		});
	}

	getNodeInfo() {
		return this.request('get', '/v1/getinfo').then((result) => {
			if (_.isUndefined(result.alias) || !_.isString(result.alias)) {
				throw new Error('Unexpected response from LN Lightning [GET /v1/getinfo]: "alias"');
			}
			if (_.isUndefined(result.identity_pubkey) || !_.isString(result.identity_pubkey)) {
				throw new Error('Unexpected response from LN Lightning [GET /v1/getinfo]: "identity_pubkey"');
			}
			if (_.isUndefined(result.uris) || !_.isArray(result.uris)) {
				throw new Error('Unexpected response from LN Lightning [GET /v1/getinfo]: "uris"');
			}
			return result;
		});
	}

	request(method, uri, data) {
		if (!_.isString(method)) {
			throw new Error('Invalid argument ("method"): String expected');
		}
		if (!_.isString(uri)) {
			throw new Error('Invalid argument ("uri"): String expected');
		}
		data = data || {};
		if (!_.isObject(data)) {
			throw new Error('Invalid argument ("data"): Object expected');
		}
		const { cert, macaroon } = this;
		let { hostname, protocol } = this.options;
		const parsedUrl = url.parse(`${protocol}://${hostname}${uri}`);
		let options = {
			method: method.toUpperCase(),
			hostname: parsedUrl.hostname,
			port: parsedUrl.port,
			path: parsedUrl.path,
			headers: {
				'Grpc-Metadata-macaroon': macaroon,
			},
			ca: cert,
		};
		if (!_.isEmpty(data)) {
			data = JSON.stringify(data);
			options.headers['Content-Type'] = 'application/json';
			options.headers['Content-Length'] = Buffer.byteLength(data);
		}
		return new Promise((resolve, reject) => {
			const done = _.once(function(error, result) {
				if (error) return reject(error);
				resolve(result);
			});
			const req = https.request(options, function(res) {
				let body = '';
				res.on('data', function(buffer) {
					body += buffer.toString();
				});
				res.on('end', function() {
					if (res.statusCode >= 300) {
						const status = res.statusCode;
						return done(new Error(`Unexpected response from LN backend: HTTP_${status}_ERROR`));
					}
					try {
						body = JSON.parse(body);
					} catch (error) {
						return done(new Error('Unexpected response format from LN backend: JSON data expected'));
					}
					done(null, body);
				});
			});
			req.once('error', done);
			if (!_.isEmpty(data)) {
				req.write(data);
			}
			req.end();
		});
	}
};

module.exports = Backend;
