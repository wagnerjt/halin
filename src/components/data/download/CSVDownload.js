import React, { Component } from 'react';
import { CSVLink } from 'react-csv';
import _ from 'lodash';
import moment from 'moment';
import { Icon } from 'semantic-ui-react';
import neo4j from '../../../api/driver/index';

// We must convert neo4j ints if present, turn JSON into string,
// and then safely escape that string for CSV
const toCsvString = obj => {
    const intermed = neo4j.handleNeo4jInt(obj);
    const asString = _.isString(intermed) ? intermed : JSON.stringify(intermed);
    
    // It sucks, but react-csv does not escape double quotes for us, so 
    // JSON objects and arrays being written as strings get hosed unless
    // you CSV escape the " characters, which is done with double "" and
    // NOT with \"
    // https://stackoverflow.com/questions/46637955/write-a-string-containing-commas-and-double-quotes-to-csv
    return !_.isNil(asString) ? asString.replace(/"/g, '""') : null;
};

export default class CSVDownload extends Component {
    getButtonText() {
        return this.props.title ? this.props.title : 'Download';
    }

    getFilename() {
        return this.props.filename ? this.props.filename : 
            `Halin-data-${moment.utc().format()}.csv`;
    }

    render() {
        // User may specify to includeHidden, which dumps to CSV columns that
        // the user can't necessarily see, but which are in the data.
        const shouldShowColumn = col => {
            if (this.props.includeHidden) { return true; }

            // Following ReactTable rules, show is default true, but can be
            // toggled off if user sets show=false.
            return _.isNil(col.show) || col.show;
        };

        // Pull out display columns, only those with accessors.
        // These are our data fields.  This intentionally skips things like
        // virtual columns which have a Cell renderer defined, but no accessor,
        // meaning that there won't be any data available for that column.
        const accessible = this.props.displayColumns
            .filter(col => col.accessor)
            .filter(col => _.isNil(col.excludeFromCSV) || !col.excludeFromCSV)
            .filter(shouldShowColumn);

        const data = this.props.data.map(obj => {
            // Each object has to be turned into a simple array,
            // ordered by the headers above.
            const row = accessible.map(col => col.accessor)
                .map(accessor => _.get(obj, accessor))
                .map(toCsvString);
            return row;
        });

        // Name the headers according to the column header or accessor.
        const headerRow = accessible.map(col => col.Header || col.accessor);

        const csvData = [headerRow].concat(data);
        // console.log('csvData', csvData);

        return (
            <CSVLink 
                filename={this.getFilename()}
                className="ui button DownloadCSV"
                data={csvData}>
                <Icon name="download"/>
                { this.getButtonText() }
            </CSVLink>
        );
    }
};