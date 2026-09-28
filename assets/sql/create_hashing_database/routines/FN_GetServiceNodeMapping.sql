create
    function FN_GetServiceNodeMapping() returns json
    READS SQL DATA
BEGIN
    RETURN (
        SELECT JSON_ARRAYagg(
               JSON_OBJECT(
                       'ServiceID', ns.service_id,
                       'NodeID', ns.node_id
               )
        ) FROM node_services as ns
    );
END;
