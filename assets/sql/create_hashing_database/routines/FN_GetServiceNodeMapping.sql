create
    definer = root@localhost function FN_GetServiceNodeMapping() returns json
BEGIN
    RETURN (
        SELECT JSON_OBJECTAGG(ns.service_id, ns.node_id) FROM node_services ns
    );
END;
