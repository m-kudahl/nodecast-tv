/** Optional MPEG-TS service/program identifier; reject structured or malformed input. */
function parseProgram(value) {
    if (value === undefined || value === null) return null;
    if (!['string', 'number'].includes(typeof value) || !/^\d{1,5}$/.test(String(value))) {
        throw new Error('Program must be an integer from 1 to 65535');
    }
    const program = Number(value);
    if (program < 1 || program > 65535) throw new Error('Program must be an integer from 1 to 65535');
    return String(program);
}

function selectProgramStreams(result, program) {
    if (program === null) return result.streams || [];
    const selected = result.programs?.find(item => String(item.program_id ?? item.program_num) === program);
    if (!selected) throw new Error('Requested program was not found in the stream');
    return selected.streams || [];
}

module.exports = { parseProgram, selectProgramStreams };
